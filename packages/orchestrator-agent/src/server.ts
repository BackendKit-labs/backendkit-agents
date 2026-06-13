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
import * as fs   from 'node:fs';
import * as http from 'node:http';
import {
    ObsidianRAGProvider,
    SimpleEmbedder,
    OllamaEmbedder,
} from '@backendkit-labs/agent-enterprise';
import { loadConfig, type OrchestratorConfig } from './config.js';
import { TaskPlanner }                           from './planner.js';
import { PlanExecutor, type ExecutionResult, type ActiveRule, ruleToGateCriteria } from './executor.js';
import { OpenAICompatibleProvider, callLLM }     from './provider.js';
import { RunStore, type RunState }               from './run-store.js';
import { matchFlow, flowToTaskPlan }             from './static-flow.js';
import { VaultWriter }                           from '@backendkit-labs/agent-enterprise';
import type { ReflectionAdapter }                from './executor.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

const ok  = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const ts  = () => new Date().toISOString();

// ── Data directory + RunStore ─────────────────────────────────────────────────
// Data lives adjacent to the config file, NOT in ~/.bk-agent (that belongs to
// the coding agent). Override with ORCHESTRATOR_DATA_DIR env var (Docker/CI)
// or data_dir key in orchestrator.yaml.

function resolveDataDir(configPath: string, config?: OrchestratorConfig): string {
    if (process.env['ORCHESTRATOR_DATA_DIR']) return process.env['ORCHESTRATOR_DATA_DIR'];
    if (config?.orchestrator.data_dir) {
        return path.resolve(path.dirname(path.resolve(configPath)), config.orchestrator.data_dir);
    }
    return path.join(path.dirname(path.resolve(configPath)), '.orchestrator');
}

const storeCache = new Map<string, RunStore>();

function getStore(configPath: string, config?: OrchestratorConfig): RunStore {
    const key = path.resolve(configPath);
    if (storeCache.has(key)) return storeCache.get(key)!;

    const store = new RunStore(path.join(resolveDataDir(key, config), 'runs'));
    storeCache.set(key, store);

    // Recovery: runs stuck in 'running' when server last crashed won't resume on
    // their own. Mark them failed. waiting_gate runs are left untouched — they
    // survive restarts because orchestrator_approve resumes from disk state.
    const interrupted = store.list().filter(r => r.status === 'running');
    for (const run of interrupted) {
        store.save({
            ...run,
            status:      'failed',
            completedAt: new Date().toISOString(),
            error:       'Server restarted while run was in progress. Re-run the task with orchestrator_run.',
        });
    }
    if (interrupted.length > 0) {
        process.stderr.write(`[orchestrator-agent] Marked ${interrupted.length} interrupted run(s) as failed\n`);
    }

    const pruned = store.prune(30);
    if (pruned > 0) {
        process.stderr.write(`[orchestrator-agent] Pruned ${pruned} old run file(s)\n`);
    }

    return store;
}

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

async function buildRAG(config: OrchestratorConfig, dataDir: string): Promise<{
    search: (q: string) => Promise<string>;
} | null> {
    const vaultCfg = config.orchestrator.vault;
    if (!vaultCfg) return null;

    const indexDir = path.join(dataDir, 'rag');
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

/**
 * Formats active policyRules into a prompt block injected into the planner.
 * The LLM uses this to set gate=true and copy the criteria into the generated plan,
 * making dynamic plans policy-aware from the start (Milestone 3).
 */
function buildPolicyContext(rules: ActiveRule[]): string {
    if (rules.length === 0) return '';

    const byDomain = new Map<string, ActiveRule[]>();
    for (const r of rules) {
        const d = r.trigger.domain;
        if (!byDomain.has(d)) byDomain.set(d, []);
        byDomain.get(d)!.push(r);
    }

    const lines = [
        'MANDATORY GATES — Active policy rules that MUST be reflected in the plan.',
        'For every step whose agent has a domain matching one below, set gate=true and include the listed gate_criteria.',
        '',
    ];

    for (const [domain, domainRules] of byDomain) {
        lines.push(`Domain: ${domain}`);
        for (const rule of domainRules) {
            const criteria = ruleToGateCriteria(rule);
            lines.push(`  • [${rule.id}] ${rule.name}`);
            lines.push(`    gate_criteria: ${criteria.map(c => `"${c}"`).join(', ')}`);
        }
        lines.push('');
    }

    return lines.join('\n');
}

async function planDynamic(
    config:      OrchestratorConfig,
    rag:         { search: (q: string) => Promise<string> } | null,
    task:        string,
    reflection?: ReflectionFull,
): Promise<import('./planner.js').TaskPlan & { error?: string }> {
    const orchProvCfg = config.providers[config.orchestrator.provider];
    if (!orchProvCfg) {
        return { summary: '', subtasks: [], error: `Provider "${config.orchestrator.provider}" not configured` };
    }
    const orchProvider = new OpenAICompatibleProvider(orchProvCfg);
    const planner      = new TaskPlanner((sys, usr) => callLLM(orchProvider, sys, usr));
    const vaultContext = rag ? await rag.search(task).catch(() => '') : undefined;

    // Milestone 3: inject active policy rules so the LLM generates gates from the start
    let policyContext: string | undefined;
    if (reflection) {
        const rules = await reflection.activeRules().catch(() => []);
        policyContext = buildPolicyContext(rules) || undefined;
    }

    try {
        return await planner.plan(task, config.agents, vaultContext, policyContext);
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
    configPath:   string,
    config:       OrchestratorConfig,
    plan:         unknown,
    rag:          { search: (q: string) => Promise<string> } | null,
    priorResults: ExecutionResult[] = [],
): Promise<void> {
    const store = getStore(configPath, config);
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

// ── startRun — shared by MCP tool and HTTP server ────────────────────────────

interface StartRunOk {
    runId:      string;
    planSource: 'static' | 'dynamic';
    plan:       import('./planner.js').TaskPlan;
    config:     OrchestratorConfig;
}

async function startRun(
    configPath: string,
    task:       string,
    flowId?:    string,
    payload:    Record<string, string> = {},
): Promise<StartRunOk | { error: string }> {
    let config: OrchestratorConfig;
    try { config = loadConfig(configPath); }
    catch (err) { return { error: `Config error: ${err instanceof Error ? err.message : String(err)}` }; }

    const dataDir    = resolveDataDir(configPath, config);
    const rag        = await buildRAG(config, dataDir).catch(() => null);
    const reflection = config.orchestrator.vault
        ? await getReflection(config.orchestrator.vault.path).catch(() => undefined)
        : undefined;
    const store      = getStore(configPath, config);
    const configDir  = path.dirname(path.resolve(configPath));

    let plan: import('./planner.js').TaskPlan;
    let planSource: 'static' | 'dynamic';

    if (flowId) {
        const entry = config.flows?.find(f => f.id === flowId);
        if (!entry) return { error: `Flow "${flowId}" not declared in orchestrator.yaml` };
        try {
            const { loadFlow } = await import('./static-flow.js');
            plan       = flowToTaskPlan(loadFlow(path.resolve(configDir, entry.file)), payload);
            planSource = 'static';
        } catch (err) {
            return { error: `Flow load error: ${err instanceof Error ? err.message : String(err)}` };
        }
    } else if (config.flows?.length) {
        const matched = matchFlow(config.flows, configDir, task);
        if (matched) {
            plan       = flowToTaskPlan(matched.flow, payload);
            planSource = 'static';
        } else {
            plan       = await planDynamic(config, rag, task, reflection);
            planSource = 'dynamic';
        }
    } else {
        plan       = await planDynamic(config, rag, task, reflection);
        planSource = 'dynamic';
    }

    if ('error' in plan) return { error: (plan as { error: string }).error };

    const runId = store.newRunId();
    store.save({ runId, task, configPath, status: 'running', startedAt: ts(), updatedAt: ts(), plan, completedSteps: [] });

    setImmediate(() => {
        executeInBackground(runId, configPath, config, plan, rag).catch(err => {
            const s = store.load(runId);
            if (s) store.save({ ...s, status: 'failed', error: String(err) });
        });
    });

    return { runId, planSource, plan, config };
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
        const result = await startRun(config_path, task, flow_id, payload);
        if ('error' in result) return ok(result.error);

        const { runId, planSource, plan, config } = result;
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
        config_path: z.string().describe('Absolute path to orchestrator.yaml — same value used in orchestrator_run'),
        run_id:      z.string().describe('Run ID returned by orchestrator_run'),
        approved:    z.boolean().describe('true to approve and continue, false to reject and stop'),
        notes:       z.string().optional().describe('Optional notes from the approver (required when rejecting)'),
    },
    async ({ config_path, run_id, approved, notes }) => {
        let config: OrchestratorConfig;
        try {
            config = loadConfig(config_path);
        } catch (err) {
            return ok(`Config error: ${err instanceof Error ? err.message : String(err)}`);
        }

        const store = getStore(config_path, config);
        const state = store.load(run_id);
        if (!state) return ok(`Run not found: ${run_id}`);
        if (state.status !== 'waiting_gate') {
            return ok(`Run \`${run_id}\` is not waiting for a gate (current status: ${state.status})`);
        }

        const gate = state.waitingGate!;

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

        const rag = await buildRAG(config, resolveDataDir(config_path, config)).catch(() => null);

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
            executeInBackground(run_id, config_path, config, state.plan, rag, priorResults).catch((err) => {
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
        config_path: z.string().describe('Absolute path to orchestrator.yaml — same value used in orchestrator_run'),
        run_id:      z.string().describe('Run ID returned by orchestrator_run'),
    },
    async ({ config_path, run_id }) => {
        const state = getStore(config_path).load(run_id);
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

// ---------------------------------------------------------------------------
// orchestrator_list_runs — list persisted runs with status summary
// ---------------------------------------------------------------------------
// @ts-ignore
srv.tool(
    'orchestrator_list_runs',
    'List all persisted orchestration runs with their current status. Runs survive server restarts — use this to see what happened before a restart or to find a run_id.',
    {
        config_path: z.string().describe('Absolute path to orchestrator.yaml'),
        status: z.enum(['running', 'waiting_gate', 'complete', 'failed', 'all']).default('all')
            .describe('Filter by status. Default: all'),
        limit: z.number().int().min(1).max(100).default(20)
            .describe('Maximum number of runs to return (most recent first). Default: 20'),
    },
    async ({ config_path, status, limit }) => {
        const all  = getStore(config_path).list();
        const runs = (status === 'all' ? all : all.filter(r => r.status === status))
            .slice(0, limit);

        if (runs.length === 0) {
            return ok(status === 'all'
                ? 'No runs found.'
                : `No runs with status "${status}".`);
        }

        const STATUS_ICON: Record<string, string> = {
            running:      '⏳',
            waiting_gate: '⏸',
            complete:     '✓',
            failed:       '✗',
        };

        const lines = [
            `## Runs (${runs.length}${status !== 'all' ? ` · status=${status}` : ''})`,
            '',
        ];

        for (const r of runs) {
            const icon     = STATUS_ICON[r.status] ?? '?';
            const taskSnip = r.task.slice(0, 70);
            const when     = r.startedAt.slice(0, 16).replace('T', ' ');
            lines.push(`${icon} \`${r.runId}\`  **${r.status}**  ${when}`);
            lines.push(`   ${taskSnip}`);
            if (r.status === 'waiting_gate' && r.waitingGate) {
                lines.push(`   ⏸ gate: step \`${r.waitingGate.stepId}\` — use \`orchestrator_approve\``);
            }
            if (r.status === 'failed' && r.error) {
                lines.push(`   ✗ ${r.error.slice(0, 120)}`);
            }
            lines.push('');
        }

        if (all.length > limit) {
            lines.push(`_(showing ${limit} of ${all.length} total — increase limit or filter by status)_`);
        }

        return ok(lines.join('\n'));
    },
);

// ── HTTP Event Trigger Server (Milestone 5) ───────────────────────────────────
// Activated by ORCHESTRATOR_HTTP_PORT + ORCHESTRATOR_CONFIG env vars.
// Lets external systems (n8n, HR platforms, ERPs) trigger flows via HTTP
// without going through Claude Desktop / MCP.
//
// Endpoints:
//   POST /run          — trigger a new run
//   GET  /status/:id   — poll run status (n8n Wait node)
//   POST /approve      — approve or reject a waiting gate
//   GET  /health       — liveness check

async function startHttpServer(
    port:       number,
    configPath: string,
    apiKey:     string | undefined,
): Promise<http.Server> {

    function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
        return new Promise((resolve, reject) => {
            const chunks: Buffer[] = [];
            req.on('data', c => chunks.push(c as Buffer));
            req.on('end', () => {
                try {
                    const text = Buffer.concat(chunks).toString('utf-8').trim();
                    resolve(text ? JSON.parse(text) as Record<string, unknown> : {});
                } catch { reject(new Error('Invalid JSON body')); }
            });
            req.on('error', reject);
        });
    }

    function reply(res: http.ServerResponse, status: number, body: unknown): void {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
    }

    const server = http.createServer(async (req, res) => {
        // Auth
        if (apiKey) {
            if (req.headers['authorization'] !== `Bearer ${apiKey}`) {
                reply(res, 401, { error: 'Unauthorized — set Authorization: Bearer <ORCHESTRATOR_API_KEY>' });
                return;
            }
        }

        const urlPath = new URL(req.url ?? '/', 'http://localhost').pathname;

        try {
            // ── GET /health ──────────────────────────────────────────────────
            if (req.method === 'GET' && urlPath === '/health') {
                reply(res, 200, { status: 'ok', configPath });
                return;
            }

            // ── POST /run ────────────────────────────────────────────────────
            if (req.method === 'POST' && urlPath === '/run') {
                const body    = await readBody(req);
                const task    = String(body['task'] ?? '').trim();
                const flowId  = body['flow_id'] != null ? String(body['flow_id']) : undefined;
                const payload = (body['payload'] ?? {}) as Record<string, string>;

                if (!task) { reply(res, 400, { error: 'task is required' }); return; }

                const result = await startRun(configPath, task, flowId, payload);
                if ('error' in result) { reply(res, 422, { error: result.error }); return; }

                reply(res, 202, {
                    runId:      result.runId,
                    status:     'running',
                    planSource: result.planSource,
                    subtasks:   result.plan.subtasks.length,
                });
                return;
            }

            // ── GET /status/:runId ───────────────────────────────────────────
            if (req.method === 'GET' && urlPath.startsWith('/status/')) {
                const runId = urlPath.slice('/status/'.length);
                if (!runId) { reply(res, 400, { error: 'runId required in path' }); return; }

                let config: OrchestratorConfig;
                try { config = loadConfig(configPath); }
                catch (err) { reply(res, 500, { error: `Config error: ${err instanceof Error ? err.message : String(err)}` }); return; }

                const state = getStore(configPath, config).load(runId);
                if (!state) { reply(res, 404, { error: `Run not found: ${runId}` }); return; }

                reply(res, 200, {
                    runId:          state.runId,
                    status:         state.status,
                    task:           state.task,
                    startedAt:      state.startedAt,
                    completedAt:    state.completedAt,
                    completedSteps: state.completedSteps.length,
                    waitingGate: state.waitingGate ? {
                        stepId:      state.waitingGate.stepId,
                        agentId:     state.waitingGate.agentId,
                        criteria:    state.waitingGate.criteria,
                        output:      state.waitingGate.output.slice(0, 1000),
                        requestedAt: state.waitingGate.requestedAt,
                    } : undefined,
                    finalReport: state.finalReport?.slice(0, 2000),
                    error:       state.error,
                });
                return;
            }

            // ── POST /approve ────────────────────────────────────────────────
            if (req.method === 'POST' && urlPath === '/approve') {
                const body     = await readBody(req);
                const runId    = String(body['run_id'] ?? '').trim();
                const approved = Boolean(body['approved']);
                const notes    = body['notes'] != null ? String(body['notes']) : undefined;

                if (!runId) { reply(res, 400, { error: 'run_id is required' }); return; }

                let config: OrchestratorConfig;
                try { config = loadConfig(configPath); }
                catch (err) { reply(res, 500, { error: `Config error: ${err instanceof Error ? err.message : String(err)}` }); return; }

                const store = getStore(configPath, config);
                const state = store.load(runId);
                if (!state)                          { reply(res, 404, { error: `Run not found: ${runId}` }); return; }
                if (state.status !== 'waiting_gate') { reply(res, 409, { error: `Run not waiting for a gate (status: ${state.status})` }); return; }

                const gate = state.waitingGate!;

                const reflection = config.orchestrator.vault
                    ? await getReflection(config.orchestrator.vault.path).catch(() => undefined)
                    : undefined;
                if (reflection && gate.appliedRuleIds?.length) {
                    const outcome: 'success' | 'failure' = approved ? 'success' : 'failure';
                    for (const id of gate.appliedRuleIds) {
                        reflection.recordRuleOutcome(id, outcome).catch(() => {});
                    }
                }

                if (!approved) {
                    store.save({
                        ...state, status: 'failed', completedAt: ts(),
                        error: `Gate rejected. Step: ${gate.stepId}. Notes: ${notes ?? '(none)'}`,
                        waitingGate: undefined,
                    });
                    reply(res, 200, { runId, status: 'failed', stepId: gate.stepId });
                    return;
                }

                store.save({ ...state, status: 'running', waitingGate: undefined });

                const rag = await buildRAG(config, resolveDataDir(configPath, config)).catch(() => null);
                const priorResults: ExecutionResult[] = state.completedSteps.map(s => ({
                    subtask_id: s.stepId, agent_id: s.agentId, task: s.task,
                    result: s.output, success: s.success, duration_ms: s.durationMs,
                }));

                setImmediate(() => {
                    executeInBackground(runId, configPath, config, state.plan, rag, priorResults).catch(err => {
                        const s = store.load(runId);
                        if (s) store.save({ ...s, status: 'failed', error: String(err) });
                    });
                });

                reply(res, 200, { runId, status: 'running', stepId: gate.stepId });
                return;
            }

            reply(res, 404, {
                error:     'Not found',
                endpoints: ['GET /health', 'POST /run', 'GET /status/:runId', 'POST /approve'],
            });

        } catch (err) {
            process.stderr.write(`[orchestrator-agent] HTTP error: ${err instanceof Error ? err.message : String(err)}\n`);
            reply(res, 500, { error: err instanceof Error ? err.message : String(err) });
        }
    });

    await new Promise<void>(resolve => server.listen(port, resolve));
    return server;
}

// ── Start ─────────────────────────────────────────────────────────────────────

async function main() {
    const httpPort      = process.env['ORCHESTRATOR_HTTP_PORT'];
    const httpConfig    = process.env['ORCHESTRATOR_CONFIG'];
    const httpApiKey    = process.env['ORCHESTRATOR_API_KEY'] || undefined;

    if (httpPort && httpConfig) {
        const port = parseInt(httpPort, 10);
        if (isNaN(port)) {
            process.stderr.write(`[orchestrator-agent] Invalid ORCHESTRATOR_HTTP_PORT: ${httpPort}\n`);
        } else {
            await startHttpServer(port, path.resolve(httpConfig), httpApiKey);
            process.stderr.write(
                `[orchestrator-agent] HTTP trigger on :${port}` +
                ` — config: ${httpConfig}` +
                (httpApiKey ? ' — auth: Bearer ***' : ' — WARNING: no API key set, all requests accepted') +
                '\n',
            );
        }
    }

    const transport = new StdioServerTransport();
    await srv.connect(transport);
    process.stderr.write('[orchestrator-agent] MCP running\n');
}

main().catch(e => {
    process.stderr.write(`[orchestrator-agent] Fatal: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
});
