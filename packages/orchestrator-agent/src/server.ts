#!/usr/bin/env node

// Load .env without external deps — only sets vars not already in process.env
import * as fsSync from 'node:fs';
import * as pathSync from 'node:path';
import { fileURLToPath } from 'node:url';
(function loadDotEnv() {
    // dist/server.js → ../../.env  (package root)
    const pkgRoot = pathSync.resolve(fileURLToPath(import.meta.url), '..', '..');
    const candidates = [pathSync.join(process.cwd(), '.env'), pathSync.join(pkgRoot, '.env')];
    for (const f of candidates) {
        if (!fsSync.existsSync(f)) continue;
        for (const line of fsSync.readFileSync(f, 'utf-8').split('\n')) {
            const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
            if (m && m[2] && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
        break;
    }
})();

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import {
    ObsidianRAGProvider,
    SimpleEmbedder,
    OllamaEmbedder,
} from '@backendkit-labs/agent-enterprise';
import { loadConfig, type OrchestratorConfig } from './config.js';
import { TaskPlanner }                           from './planner.js';
import { PlanExecutor, type ExecutionResult }    from './executor.js';
import { OpenAICompatibleProvider, callLLM }     from './provider.js';
import { RunStore, type RunState }               from './run-store.js';
import { matchFlow, flowToTaskPlan }             from './static-flow.js';
import { VaultWriter }                           from '@backendkit-labs/agent-enterprise';
import type { ReflectionAdapter }                from './executor.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const ok  = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const ts  = () => new Date().toISOString();

// ── Shared state ──────────────────────────────────────────────────────────────

const store = new RunStore();

// ── Enterprise reflection (Cable 1 + 2) ──────────────────────────────────────
// Lazy-initialized per vault path. Uses EnterpriseReflection from
// @backendkit-labs/agent-enterprise when available (>= 0.4.0).
// No-op (undefined) with the current published version — both cables degrade
// gracefully: Cable 1 skips recording, Cable 2 applies no extra gates.

// ReflectionFull extends the minimal Cable-2 interface with the human-facing
// lifecycle methods (promotions, demotions, stats) used by orchestrator_reflect tools.
// EnterpriseReflection from @backendkit-labs/agent-enterprise satisfies this structurally.
interface ReflectionFull extends ReflectionAdapter {
    pendingPromotions(): Promise<Array<{
        pattern: {
            domain: string; failureType: string; occurrences: number;
            promotedToPolicy: boolean; [k: string]: unknown;
        };
        detectedAt: string;
    }>>;
    approvePromotion(
        pattern:  Record<string, unknown>,
        approver: string,
    ): Promise<{ id: string; name: string; [k: string]: unknown }>;
    rejectPromotion(
        pattern:  Record<string, unknown>,
        approver: string,
        reason:   string,
    ): Promise<void>;
    demotionCandidates(opts?: { minFailureRatio?: number; minTotal?: number }): Promise<Array<{
        id: string; name: string;
        trigger: { domain: string; pattern: string; minOccurrences: number };
        outcomes?: { success: number; failure: number };
        [k: string]: unknown;
    }>>;
    approveDemotion(ruleId: string, approver: string, reason: string): Promise<boolean>;
    stats(): Promise<Record<string, unknown>>;
}

const reflectionCache = new Map<string, ReflectionFull>();

async function getReflection(vaultPath: string): Promise<ReflectionFull | undefined> {
    if (reflectionCache.has(vaultPath)) return reflectionCache.get(vaultPath);
    try {
        // Dynamic import so missing export in old package versions doesn't throw
        const lib = await import('@backendkit-labs/agent-enterprise') as Record<string, unknown>;
        const EnterpriseReflection = lib['EnterpriseReflection'] as
            (new (o: { vaultPath: string }) => ReflectionFull & { initialize(): Promise<void> }) | undefined;
        if (!EnterpriseReflection) return undefined;
        const r = new EnterpriseReflection({ vaultPath });
        await r.initialize();
        reflectionCache.set(vaultPath, r);
        return r;
    } catch {
        return undefined;
    }
}

// ── RAG setup ─────────────────────────────────────────────────────────────────

async function buildRAG(config: OrchestratorConfig): Promise<{
    search: (q: string) => Promise<string>;
} | null> {
    const vaultCfg = config.orchestrator.vault;
    if (!vaultCfg) return null;

    const indexDir  = path.join(os.homedir(), '.bk-agent', 'rag', 'orchestrator');
    fs.mkdirSync(indexDir, { recursive: true });

    const embedder = vaultCfg.embedder === 'ollama'
        ? new OllamaEmbedder({ host: vaultCfg.ollama_host, model: vaultCfg.ollama_model })
        : new SimpleEmbedder();

    const rag = new ObsidianRAGProvider({
        vaultPath: vaultCfg.path,
        indexPath: path.join(indexDir, 'vault.json'),
        embedder,
        topK:      5,
        minScore:  0.1,
    });

    await rag.index({ verbose: false });

    return {
        search: (query: string) => rag.search(query),
    };
}

// ── Planning helpers ──────────────────────────────────────────────────────────

async function planDynamic(
    config:  OrchestratorConfig,
    rag:     { search: (q: string) => Promise<string> } | null,
    task:    string,
): Promise<import('./planner.js').TaskPlan & { error?: string }> {
    const orchProvCfg = config.providers[config.orchestrator.provider];
    if (!orchProvCfg) {
        return { summary: '', subtasks: [], error: `Provider "${config.orchestrator.provider}" not configured` };
    }
    const orchProvider = new OpenAICompatibleProvider(orchProvCfg);
    const planner      = new TaskPlanner((sys, usr) => callLLM(orchProvider, sys, usr));
    const vaultContext = rag ? await rag.search(task).catch(() => '') : undefined;
    try {
        return await planner.plan(task, config.agents, vaultContext);
    } catch (err) {
        return { summary: '', subtasks: [], error: `Planning error: ${err instanceof Error ? err.message : String(err)}` };
    }
}

// ── Background execution ──────────────────────────────────────────────────────

/**
 * Run plan segments in the background (after orchestrator_run already returned
 * the runId). Updates the RunStore as steps complete or gates are hit.
 *
 * @param priorResults  Steps already completed — used when resuming after a gate.
 */
async function executeInBackground(
    runId:        string,
    config:       OrchestratorConfig,
    plan:         unknown,
    rag:          { search: (q: string) => Promise<string> } | null,
    priorResults: ExecutionResult[] = [],
): Promise<void> {
    const state = store.load(runId);
    if (!state) return;

    // Cable 1 + 2: wire reflection adapter when vault is configured
    const reflection = config.orchestrator.vault
        ? await getReflection(config.orchestrator.vault.path).catch(() => undefined)
        : undefined;

    const executor = new PlanExecutor({
        config,
        ragSearchFn: rag?.search,
        reflection,
        // Mark each step as "in progress" in the RunStore before running it
        onProgress: (msg) => {
            const match = msg.match(/\[([^\]]+)\]/);
            if (match) {
                const current = store.load(runId);
                if (current && current.status === 'running') {
                    store.save({ ...current, currentStep: { stepId: match[1], agentId: match[1], startedAt: ts() } });
                }
            }
        },
    });

    try {
        const result = await executor.execute(plan as Parameters<typeof executor.execute>[0], priorResults);

        if ('gateRequired' in result) {
            store.save({
                ...state,
                status:         'waiting_gate',
                currentStep:    undefined,
                completedSteps: result.completedSoFar.map(toStepResult),
                waitingGate: {
                    gateId:          result.stepId,
                    stepId:          result.stepId,
                    agentId:         result.agentId,
                    output:          result.output,
                    criteria:        result.criteria,
                    requestedAt:     ts(),
                    appliedRuleIds:  result.appliedRuleIds.length ? result.appliedRuleIds : undefined,
                },
            });
        } else {
            // Write final report to vault if vault is configured
            let vaultNotePath: string | undefined;
            if (config.orchestrator.vault) {
                try {
                    const writer = new VaultWriter({ vaultPath: config.orchestrator.vault.path });
                    vaultNotePath = await writer.writeNote({
                        title:       `Run ${runId} — ${state.task.slice(0, 60)}`,
                        content:     result.summary,
                        agentId:     'orchestrator',
                        tags:        ['área/orquestador', 'función/resultado'],
                        description: state.task.slice(0, 120),
                    });
                } catch { /* vault write is best-effort */ }
            }

            store.save({
                ...state,
                status:         'complete',
                completedAt:    ts(),
                currentStep:    undefined,
                completedSteps: result.results.map(toStepResult),
                finalReport:    result.summary,
                vaultNotePath,
                waitingGate:    undefined,
            });
        }
    } catch (err) {
        store.save({
            ...state,
            status:      'failed',
            currentStep: undefined,
            error:       err instanceof Error ? err.message : String(err),
        });
    }
}

function toStepResult(r: ExecutionResult): import('./run-store.js').StepResult {
    return {
        stepId:     r.subtask_id,
        agentId:    r.agent_id,
        task:       r.task,
        output:     r.result,
        success:    r.success,
        durationMs: r.duration_ms,
    };
}

// ── MCP Server ────────────────────────────────────────────────────────────────

const srv = new McpServer({
    name:    '@backendkit-labs/orchestrator-agent',
    version: '0.1.0',
});

// ---------------------------------------------------------------------------
// orchestrator_run — plan synchronously, execute in background, return runId
// ---------------------------------------------------------------------------
// @ts-ignore
srv.tool(
    'orchestrator_run',
    'Start a coordinated multi-agent task. Automatically uses a pre-defined static flow if the task matches one; otherwise the LLM plans dynamically. Returns a runId immediately — poll with orchestrator_status. Use orchestrator_approve when a gate is reached.',
    {
        config_path: z.string().describe('Absolute path to orchestrator.yaml'),
        task:        z.string().describe('Task description in natural language'),
        flow_id:     z.string().optional().describe('Force a specific static flow ID instead of auto-detection'),
        payload:     z.record(z.string()).optional().describe(
            'Key-value pairs for {{payload.key}} interpolation in static flow templates ' +
            '(e.g. {"nombre": "Juan", "puesto": "Developer", "fecha_ingreso": "2026-07-01"})',
        ),
    },
    async ({ config_path, task, flow_id, payload = {} }) => {
        let config: OrchestratorConfig;
        try {
            config = loadConfig(config_path);
        } catch (err) {
            return ok(`Config error: ${err instanceof Error ? err.message : String(err)}`);
        }

        const rag        = await buildRAG(config).catch(() => null);
        const configDir  = path.dirname(path.resolve(config_path));

        // ── Resolve plan: static flow or dynamic TaskPlanner ─────────────────
        let plan: import('./planner.js').TaskPlan;
        let planSource: 'static' | 'dynamic';

        // Explicit flow_id → load directly
        if (flow_id) {
            const entry = config.flows?.find(f => f.id === flow_id);
            if (!entry) return ok(`Flow "${flow_id}" not declared in orchestrator.yaml`);
            const flowPath = path.resolve(configDir, entry.file);
            try {
                const { loadFlow } = await import('./static-flow.js');
                const flow = loadFlow(flowPath);
                plan       = flowToTaskPlan(flow, payload);
                planSource = 'static';
            } catch (err) {
                return ok(`Flow load error: ${err instanceof Error ? err.message : String(err)}`);
            }
        // Auto-detect via trigger matching
        } else if (config.flows?.length) {
            const matched = matchFlow(config.flows, configDir, task);
            if (matched) {
                plan       = flowToTaskPlan(matched.flow, payload);
                planSource = 'static';
            } else {
                plan       = await planDynamic(config, rag, task);
                planSource = 'dynamic';
            }
        // No flows declared → always dynamic
        } else {
            plan       = await planDynamic(config, rag, task);
            planSource = 'dynamic';
        }

        if ('error' in plan) return ok((plan as { error: string }).error);

        // ── Create run and fire background execution ──────────────────────────
        const runId  = store.newRunId();
        const state: RunState = {
            runId,
            task,
            configPath:     config_path,
            status:         'running',
            startedAt:      ts(),
            updatedAt:      ts(),
            plan,
            completedSteps: [],
        };
        store.save(state);

        setImmediate(() => {
            executeInBackground(runId, config, plan, rag).catch((err) => {
                const s = store.load(runId);
                if (s) store.save({ ...s, status: 'failed', error: String(err) });
            });
        });

        const planLines = plan.subtasks.map(st => {
            const agentCfg  = config.agents.find(a => a.id === st.agent_id);
            const gateLabel = (st.gate ?? agentCfg?.gate) ? ' [GATE]' : '';
            return `  • [${st.agent_id}]${gateLabel} ${st.task.slice(0, 90)}`;
        });

        return ok([
            `## Run iniciado  (${planSource === 'static' ? 'flow estático' : 'plan dinámico'})`,
            `runId: \`${runId}\``,
            `status: running`,
            '',
            `### Plan: ${plan.summary}`,
            planLines.join('\n'),
            '',
            `Poll con \`orchestrator_status\` para ver el progreso.`,
            `Si aparece un gate, usá \`orchestrator_approve\` para continuar o rechazar.`,
        ].join('\n'));
    },
);

// ---------------------------------------------------------------------------
// orchestrator_approve — approve or reject a waiting gate
// ---------------------------------------------------------------------------
// @ts-ignore
srv.tool(
    'orchestrator_approve',
    'Approve or reject a gate that paused a running orchestration. If approved, execution resumes automatically.',
    {
        run_id:   z.string().describe('Run ID returned by orchestrator_run'),
        approved: z.boolean().describe('true to approve and continue, false to reject and stop'),
        notes:    z.string().optional().describe('Optional notes from the approver (required when rejecting)'),
    },
    async ({ run_id, approved, notes }) => {
        const state = store.load(run_id);
        if (!state) return ok(`Run not found: ${run_id}`);
        if (state.status !== 'waiting_gate') {
            return ok(`Run \`${run_id}\` is not waiting for a gate (current status: ${state.status})`);
        }

        const gate = state.waitingGate!;

        // Reload config early — needed for reflection in both approve and reject paths
        let config: OrchestratorConfig;
        try {
            config = loadConfig(state.configPath);
        } catch (err) {
            return ok(`Config error on resume: ${err instanceof Error ? err.message : String(err)}`);
        }

        // Cable 2: record rule outcomes so the reflection engine tracks effectiveness
        const reflection = config.orchestrator.vault
            ? await getReflection(config.orchestrator.vault.path).catch(() => undefined)
            : undefined;

        if (reflection && gate.appliedRuleIds?.length) {
            const outcome: 'success' | 'failure' = approved ? 'success' : 'failure';
            for (const ruleId of gate.appliedRuleIds) {
                reflection.recordRuleOutcome(ruleId, outcome).catch(() => { /* best-effort */ });
            }
        }

        if (!approved) {
            store.save({
                ...state,
                status:      'failed',
                completedAt: ts(),
                error:       `Gate rejected by approver. Step: ${gate.stepId}. Notes: ${notes ?? '(none)'}`,
                waitingGate: undefined,
            });
            return ok([
                `Gate rejected — run \`${run_id}\` stopped.`,
                `Step: ${gate.stepId} (${gate.agentId})`,
                notes ? `Notes: ${notes}` : '',
            ].filter(Boolean).join('\n'));
        }

        const rag = await buildRAG(config).catch(() => null);

        // Mark gate as cleared, resume in background
        const resumeState: RunState = {
            ...state,
            status:     'running',
            waitingGate: undefined,
        };
        store.save(resumeState);

        const priorResults: ExecutionResult[] = state.completedSteps.map(s => ({
            subtask_id:  s.stepId,
            agent_id:    s.agentId,
            task:        s.task,
            result:      s.output,
            success:     s.success,
            duration_ms: s.durationMs,
        }));

        setImmediate(() => {
            executeInBackground(run_id, config, state.plan, rag, priorResults).catch((err) => {
                const s = store.load(run_id);
                if (s) store.save({ ...s, status: 'failed', error: String(err) });
            });
        });

        return ok([
            `Gate approved — run \`${run_id}\` resuming.`,
            `Step: ${gate.stepId} (${gate.agentId})`,
            notes ? `Notes: ${notes}` : '',
            '',
            `Poll with \`orchestrator_status\` to see progress.`,
        ].filter(Boolean).join('\n'));
    },
);

// ---------------------------------------------------------------------------
// orchestrator_list_agents — show configured agents
// ---------------------------------------------------------------------------
// @ts-ignore
srv.tool(
    'orchestrator_list_agents',
    'List all specialist agents configured in orchestrator.yaml with their capabilities.',
    {
        config_path: z.string().describe('Absolute path to orchestrator.yaml'),
    },
    async ({ config_path }) => {
        let config: OrchestratorConfig;
        try {
            config = loadConfig(config_path);
        } catch (err) {
            return ok(`Config error: ${err instanceof Error ? err.message : String(err)}`);
        }

        const lines = [
            `## ${config.orchestrator.name}`,
            `Orchestrator provider: ${config.orchestrator.provider}`,
            config.orchestrator.vault ? `Vault: ${config.orchestrator.vault.path}` : 'Vault: not configured',
            '',
            `### Configured agents (${config.agents.length})`,
        ];

        for (const a of config.agents) {
            const gateLabel = a.gate ? ' [GATE]' : '';
            lines.push(`\n**${a.name}** (\`${a.id}\`)${gateLabel}  provider: ${a.provider}`);
            lines.push(`  ${a.description}`);
            lines.push(`  capabilities: ${a.capabilities.join(', ')}`);
            if (a.gate_criteria?.length) {
                lines.push(`  gate criteria: ${a.gate_criteria.join(' | ')}`);
            }
        }

        return ok(lines.join('\n'));
    },
);

// ---------------------------------------------------------------------------
// orchestrator_status — get run status
// ---------------------------------------------------------------------------
// @ts-ignore
srv.tool(
    'orchestrator_status',
    'Get the status of a running or completed orchestration by runId.',
    {
        run_id: z.string().describe('Run ID returned by orchestrator_run'),
    },
    async ({ run_id }) => {
        const state = store.load(run_id);
        if (!state) return ok(`Run not found: ${run_id}`);

        const lines: string[] = [
            `## Run \`${state.runId}\``,
            `status: **${state.status}**`,
            `task: ${state.task}`,
            `started: ${state.startedAt}`,
            state.completedAt ? `completed: ${state.completedAt}` : '',
            '',
            `### Pasos completados (${state.completedSteps.length})`,
            ...state.completedSteps.map(s =>
                `${s.success ? '✓' : '✗'} [${s.agentId}] ${s.task.slice(0, 80)}`
            ),
        ];

        if (state.status === 'running' && state.currentStep) {
            lines.push('', `⏳ En progreso: [${state.currentStep.agentId}] desde ${state.currentStep.startedAt}`);
        }

        if (state.status === 'waiting_gate' && state.waitingGate) {
            const g = state.waitingGate;
            lines.push('', `### ⏸ Gate waiting for approval`);
            lines.push(`Step: \`${g.stepId}\`  Agent: ${g.agentId}`);
            lines.push(`Requested: ${g.requestedAt}`);
            if (g.criteria.length) {
                lines.push('', 'Criteria to evaluate:');
                g.criteria.forEach(c => lines.push(`  - ${c}`));
            }
            lines.push('', '**Agent output:**');
            lines.push(g.output.slice(0, 800));
            lines.push('', `Use \`orchestrator_approve\` with run_id: "${state.runId}" to continue or reject.`);
        }

        if (state.status === 'complete' && state.finalReport) {
            if (state.vaultNotePath) {
                lines.push('', `📝 Guardado en vault: \`${path.basename(state.vaultNotePath)}\``);
            }
            lines.push('', '### Reporte final', state.finalReport);
        }

        if (state.status === 'failed' && state.error) {
            lines.push('', `### Error`, state.error);
        }

        return ok(lines.filter(l => l !== undefined).join('\n'));
    },
);

// ---------------------------------------------------------------------------
// orchestrator_reflect — dashboard: pending promotions, active rules, demotion candidates
// ---------------------------------------------------------------------------
// @ts-ignore
srv.tool(
    'orchestrator_reflect',
    'View enterprise reflection status: pending pattern promotions, active policy rules, and demotion candidates. Call this to understand what the system has learned from gate outcomes and to decide what to promote or demote.',
    {
        config_path: z.string().describe('Absolute path to orchestrator.yaml'),
    },
    async ({ config_path }) => {
        let config: OrchestratorConfig;
        try { config = loadConfig(config_path); }
        catch (err) { return ok(`Config error: ${err instanceof Error ? err.message : String(err)}`); }

        if (!config.orchestrator.vault) {
            return ok('Vault not configured in orchestrator.yaml — reflection requires a vault path.');
        }

        const reflection = await getReflection(config.orchestrator.vault.path).catch(() => undefined);
        if (!reflection) {
            return ok('Enterprise reflection not available. Install @backendkit-labs/agent-enterprise >= 0.4.0.');
        }

        const [pending, active, demotable, statsData] = await Promise.all([
            reflection.pendingPromotions().catch(() => []),
            reflection.activeRules().catch(() => []),
            reflection.demotionCandidates().catch(() => []),
            reflection.stats().catch(() => ({} as Record<string, unknown>)),
        ]);

        const lines: string[] = [
            `## Reflection Status — bk-enterprise`,
            `vault: ${config.orchestrator.vault.path}`,
            typeof statsData['catalogSize'] === 'number'
                ? `catalog: ${statsData['catalogSize']} incidents`
                : '',
            `active rules: ${active.length} | pending promotions: ${pending.length} | demotion candidates: ${demotable.length}`,
            '',
        ];

        // ── Pending Promotions ──────────────────────────────────────────────────
        lines.push(`### Pending Promotions (${pending.length})`);
        if (pending.length === 0) {
            lines.push('None — no patterns have crossed the promotion threshold yet.');
        } else {
            lines.push('These patterns crossed the severity threshold. Approve to create a deterministic policy rule (Cable 2); reject to discard with audit note.');
            lines.push('');
            pending.forEach((p, i) => {
                const key = `${p.pattern.domain}::${p.pattern.failureType}`;
                lines.push(`**${i + 1}. ${key}**`);
                lines.push(`   domain: ${p.pattern.domain} | failureType: ${p.pattern.failureType} | occurrences: ${p.pattern.occurrences}`);
                lines.push(`   detected: ${p.detectedAt}`);
                lines.push(`   → \`orchestrator_reflect_promote\`  promotion_id: "${key}"`);
                lines.push('');
            });
        }

        // ── Active Policy Rules ─────────────────────────────────────────────────
        lines.push(`### Active Policy Rules (${active.length})`);
        if (active.length === 0) {
            lines.push('None — approve a pending promotion to create the first rule.');
        } else {
            lines.push('Enforced automatically before any matching step (Cable 2) — no LLM involved.');
            lines.push('');
            for (const r of active) {
                const outs = (r as { outcomes?: { success: number; failure: number } }).outcomes;
                const outcomeStr = outs
                    ? `${outs.success} success / ${outs.failure} failure`
                    : 'no outcomes recorded yet';
                lines.push(`**[${r.id}] ${r.name}**`);
                lines.push(`   trigger: domain ${r.trigger.domain} | pattern: ${r.trigger.pattern}`);
                lines.push(`   outcomes: ${outcomeStr}`);
                lines.push('');
            }
        }

        // ── Demotion Candidates ─────────────────────────────────────────────────
        lines.push(`### Demotion Candidates (${demotable.length})`);
        if (demotable.length === 0) {
            lines.push('None — all active rules within acceptable failure rates.');
        } else {
            lines.push('Rules with ≥50% failure rate over ≥4 applications. Consider removing to avoid false positives.');
            lines.push('');
            for (const r of demotable) {
                const outs  = r.outcomes!;
                const total = outs.success + outs.failure;
                const pct   = Math.round((outs.failure / total) * 100);
                lines.push(`**[${r.id}] ${r.name}**`);
                lines.push(`   outcomes: ${outs.success} success / ${outs.failure} failure (${pct}% failure rate)`);
                lines.push(`   → \`orchestrator_reflect_demote\`  rule_id: "${r.id}"`);
                lines.push('');
            }
        }

        return ok(lines.filter(l => l !== '').join('\n'));
    },
);

// ---------------------------------------------------------------------------
// orchestrator_reflect_promote — approve or reject a pending pattern promotion
// ---------------------------------------------------------------------------
// @ts-ignore
srv.tool(
    'orchestrator_reflect_promote',
    'Approve or reject a pending pattern promotion. Approving writes a deterministic policy rule to manifest.yaml — enforced automatically on every matching step (Cable 2). Rejecting discards the promotion with an audit note in the failure catalog.',
    {
        config_path:  z.string().describe('Absolute path to orchestrator.yaml'),
        promotion_id: z.string().describe('Promotion identifier in format "domain::failureType" — copy from orchestrator_reflect output'),
        approved:     z.boolean().describe('true to create a policy rule; false to discard'),
        approver:     z.string().describe('Identity of the human approver (name or email — written to the audit trail)'),
        reason:       z.string().optional().describe('Required when rejecting; optional context note when approving'),
    },
    async ({ config_path, promotion_id, approved, approver, reason }) => {
        if (!approved && !reason) {
            return ok('reason is required when rejecting a promotion.');
        }

        let config: OrchestratorConfig;
        try { config = loadConfig(config_path); }
        catch (err) { return ok(`Config error: ${err instanceof Error ? err.message : String(err)}`); }

        if (!config.orchestrator.vault) return ok('Vault not configured in orchestrator.yaml.');

        const reflection = await getReflection(config.orchestrator.vault.path).catch(() => undefined);
        if (!reflection) return ok('Enterprise reflection not available (requires agent-enterprise >= 0.4.0).');

        const pending = await reflection.pendingPromotions().catch(() => []);
        const entry   = pending.find(p =>
            `${p.pattern.domain}::${p.pattern.failureType}` === promotion_id,
        );

        if (!entry) {
            const available = pending
                .map(p => `${p.pattern.domain}::${p.pattern.failureType}`)
                .join(', ');
            return ok(
                `Promotion "${promotion_id}" not found in pending list.\n` +
                (available ? `Available: ${available}` : 'No pending promotions — run orchestrator_reflect first.'),
            );
        }

        if (approved) {
            try {
                const rule = await reflection.approvePromotion(
                    entry.pattern as Record<string, unknown>, approver,
                );
                return ok([
                    `### Promotion approved ✓`,
                    `Rule created: **[${rule.id}] ${rule.name}**`,
                    `domain: ${entry.pattern.domain} | failureType: ${entry.pattern.failureType}`,
                    `approver: ${approver}`,
                    reason ? `note: ${reason}` : '',
                    '',
                    `Rule is now active — matching steps will be automatically gated (Cable 2).`,
                    `Run \`orchestrator_reflect\` to see the updated active rules list.`,
                ].filter(Boolean).join('\n'));
            } catch (err) {
                return ok(`Approval failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        } else {
            try {
                await reflection.rejectPromotion(
                    entry.pattern as Record<string, unknown>, approver, reason!,
                );
                return ok([
                    `### Promotion rejected`,
                    `Pattern: ${promotion_id}`,
                    `approver: ${approver} | reason: ${reason}`,
                    '',
                    `Promotion discarded. Pattern will re-appear if the failure type continues to occur.`,
                ].join('\n'));
            } catch (err) {
                return ok(`Rejection failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    },
);

// ---------------------------------------------------------------------------
// orchestrator_reflect_demote — approve demotion of an active policy rule
// ---------------------------------------------------------------------------
// @ts-ignore
srv.tool(
    'orchestrator_reflect_demote',
    'Approve demotion of an active policy rule with a high failure rate. Removes it from manifest.yaml with a full audit trail written to the failure catalog. Symmetric with orchestrator_reflect_promote — the rulebook only changes in either direction with explicit human approval.',
    {
        config_path: z.string().describe('Absolute path to orchestrator.yaml'),
        rule_id:     z.string().describe('Rule ID to demote — copy from orchestrator_reflect demotion candidates'),
        approver:    z.string().describe('Identity of the human approver (name or email)'),
        reason:      z.string().describe('Reason for demotion — written to the audit trail'),
    },
    async ({ config_path, rule_id, approver, reason }) => {
        let config: OrchestratorConfig;
        try { config = loadConfig(config_path); }
        catch (err) { return ok(`Config error: ${err instanceof Error ? err.message : String(err)}`); }

        if (!config.orchestrator.vault) return ok('Vault not configured in orchestrator.yaml.');

        const reflection = await getReflection(config.orchestrator.vault.path).catch(() => undefined);
        if (!reflection) return ok('Enterprise reflection not available (requires agent-enterprise >= 0.4.0).');

        const activeRules = await reflection.activeRules().catch(() => []);
        const rule        = activeRules.find(r => r.id === rule_id);
        if (!rule) {
            const ids = activeRules.map(r => `${r.id} (${r.name})`).join(', ');
            return ok(
                `Rule "${rule_id}" not found in active rules.\n` +
                (ids ? `Active rules: ${ids}` : 'No active rules.'),
            );
        }

        try {
            const removed = await reflection.approveDemotion(rule_id, approver, reason);
            if (!removed) {
                return ok(`Demotion failed — "${rule_id}" could not be removed from manifest.yaml.`);
            }
            const outs = (rule as { outcomes?: { success: number; failure: number } }).outcomes;
            return ok([
                `### Rule demoted ✓`,
                `Rule: **[${rule_id}] ${rule.name}**`,
                `trigger domain: ${rule.trigger.domain}`,
                outs ? `final outcomes: ${outs.success} success / ${outs.failure} failure` : '',
                `approver: ${approver} | reason: ${reason}`,
                '',
                `Rule removed from manifest.yaml — no longer enforced on new steps.`,
                `Audit note written to failure catalog.`,
                `Run \`orchestrator_reflect\` to verify the updated rules list.`,
            ].filter(Boolean).join('\n'));
        } catch (err) {
            return ok(`Demotion failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    },
);

// ── Start ─────────────────────────────────────────────────────────────────────

async function main() {
    const transport = new StdioServerTransport();
    await srv.connect(transport);
    process.stderr.write('[orchestrator-agent] Running\n');
}

main().catch(e => {
    process.stderr.write(`[orchestrator-agent] Fatal: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
});
