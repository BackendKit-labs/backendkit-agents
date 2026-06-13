import {
    AgentEngine,
    AgentRegistry,
    ToolRegistry,
    ProviderRegistry,
    CallbackTransport,
    defineTool,
} from '@backendkit-labs/agent-core';
import type { AgentProfile, AgentEvent } from '@backendkit-labs/agent-core';
import { z } from 'zod';
import type { OrchestratorConfig, AgentConfig } from './config.js';
import type { TaskPlan, SubTask } from './planner.js';
import { OpenAICompatibleProvider, callLLM } from './provider.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ExecutionResult {
    subtask_id:  string;
    agent_id:    string;
    task:        string;
    result:      string;
    success:     boolean;
    duration_ms: number;
}

export interface PlanExecution {
    plan:     TaskPlan;
    results:  ExecutionResult[];
    summary:  string;
    complete: boolean;
}

/** Returned instead of PlanExecution when a gate step is reached. */
export interface GateHit {
    gateRequired:    true;
    stepId:          string;
    agentId:         string;
    output:          string;   // agent output shown to the approver
    criteria:        string[];
    completedSoFar:  ExecutionResult[];
    /** IDs of policyRules that forced this gate (empty when gate is explicit in YAML/config). */
    appliedRuleIds:  string[];
}

/**
 * Minimal interface for the enterprise reflection adapter (Cable 2).
 * EnterpriseReflection from @backendkit-labs/agent-enterprise satisfies this
 * structurally — no direct import needed, avoiding circular dep on publish cycle.
 */
export interface ReflectionAdapter {
    activeRules(filter?: { domain?: string }): Promise<Array<{
        id:      string;
        name:    string;
        trigger: { domain: string; pattern: string; minOccurrences: number };
        if:      { domain?: string | string[]; keywords?: string[]; [k: string]: unknown };
        then:    {
            mustInclude?:            string[];
            mustPass?:               string[];
            mustExecute?:            string[];
            requireArchitectureReview?: boolean;
            requireSecurityReview?:     boolean;
            requireQaApproval?:         boolean;
            [k: string]: unknown;
        };
    }>>;
    recordRuleOutcome(ruleId: string, outcome: 'success' | 'failure'): Promise<void>;
}

export interface ExecutorOptions {
    config:       OrchestratorConfig;
    ragSearchFn?: (query: string) => Promise<string>;
    onProgress?:  (msg: string) => void;
    /** Enterprise reflection adapter for deterministic rule enforcement (Cable 2). */
    reflection?:  ReflectionAdapter;
}

// ── Executor ──────────────────────────────────────────────────────────────────

export class PlanExecutor {
    private readonly config:      OrchestratorConfig;
    private readonly ragSearchFn: ((q: string) => Promise<string>) | undefined;
    private readonly onProgress:  (msg: string) => void;
    private readonly reflection:  ReflectionAdapter | undefined;

    constructor(opts: ExecutorOptions) {
        this.config      = opts.config;
        this.ragSearchFn = opts.ragSearchFn;
        this.onProgress  = opts.onProgress ?? (() => {});
        this.reflection  = opts.reflection;
    }

    /**
     * Execute a plan from scratch or resume after a gate approval.
     *
     * @param plan           Full task plan.
     * @param priorResults   Steps already completed in a previous execution segment
     *                       (used when resuming after a gate). Those steps are treated
     *                       as done and skipped.
     */
    async execute(plan: TaskPlan, priorResults: ExecutionResult[] = []): Promise<PlanExecution | GateHit> {
        const results: ExecutionResult[] = [...priorResults];
        const completed = new Set<string>(priorResults.map(r => r.subtask_id));

        const remaining = plan.subtasks.filter(st => !completed.has(st.id));

        while (remaining.length > 0) {
            const ready = remaining.filter(st =>
                st.depends_on.every(dep => completed.has(dep)),
            );
            if (ready.length === 0) {
                throw new Error('Circular dependency detected in task plan');
            }

            for (const subtask of ready) {
                // Resolve explicit gate from subtask or agent config
                const agentCfg       = this.config.agents.find(a => a.id === subtask.agent_id);
                const needsGate      = subtask.gate ?? agentCfg?.gate ?? false;
                const explicitCriteria = subtask.gate_criteria ?? agentCfg?.gate_criteria ?? [];

                // ── Cable 2: check active policyRules before running ───────────
                // Rules that match this step add criteria to the gate, turning
                // un-gated steps into gated ones — deterministically, without LLM.
                const { matchedRuleIds, ruleCriteria } = await this.checkActiveRules(
                    subtask.task,
                    agentCfg?.domain,
                );
                const forceGate  = matchedRuleIds.length > 0;
                const allCriteria = [...explicitCriteria, ...ruleCriteria];

                if (forceGate) {
                    this.onProgress(
                        `  ⚠ [${subtask.id}] ${matchedRuleIds.length} policy rule(s) applied — gate enforced`,
                    );
                }
                // ─────────────────────────────────────────────────────────────────

                const result = await this.runSubTask(subtask, results);
                results.push(result);
                completed.add(subtask.id);
                remaining.splice(remaining.indexOf(subtask), 1);

                if ((needsGate || forceGate) && result.success) {
                    return {
                        gateRequired:   true,
                        stepId:         subtask.id,
                        agentId:        subtask.agent_id,
                        output:         result.result,
                        criteria:       allCriteria,
                        completedSoFar: results,
                        appliedRuleIds: matchedRuleIds,
                    };
                }
            }
        }

        const summary = this.consolidate(plan, results);
        return { plan, results, summary, complete: true };
    }

    private async runSubTask(subtask: SubTask, priorResults: ExecutionResult[]): Promise<ExecutionResult> {
        const agentCfg = this.config.agents.find(a => a.id === subtask.agent_id);
        this.onProgress(`  → [${subtask.id}] ${agentCfg?.name ?? subtask.agent_id}: ${subtask.task.slice(0, 80)}…`);

        const start = Date.now();
        try {
            const result = agentCfg
                ? await this.runSpecialist(agentCfg, subtask, priorResults)
                : `No agent configured for id: ${subtask.agent_id}`;

            return {
                subtask_id: subtask.id,
                agent_id:   subtask.agent_id,
                task:       subtask.task,
                result,
                success:    true,
                duration_ms: Date.now() - start,
            };
        } catch (err) {
            return {
                subtask_id: subtask.id,
                agent_id:   subtask.agent_id,
                task:       subtask.task,
                result:     `Error: ${err instanceof Error ? err.message : String(err)}`,
                success:    false,
                duration_ms: Date.now() - start,
            };
        }
    }

    private async runSpecialist(
        agentCfg: AgentConfig,
        subtask: SubTask,
        priorResults: ExecutionResult[],
    ): Promise<string> {
        const providerCfg = this.config.providers[agentCfg.provider];
        if (!providerCfg) {
            throw new Error(`Provider "${agentCfg.provider}" not configured for agent "${agentCfg.id}"`);
        }

        const provider = new OpenAICompatibleProvider(providerCfg);

        // Build vault context for this specialist
        let vaultContext = '';
        if (this.ragSearchFn) {
            try { vaultContext = await this.ragSearchFn(subtask.task); } catch { /* vault optional */ }
        }

        // Include relevant prior results as context
        const priorContext = priorResults.length > 0
            ? '\n\nContext from previous steps:\n' +
              priorResults.map(r => `[${r.agent_id}] ${r.task}\n→ ${r.result.slice(0, 300)}`).join('\n\n')
            : '';

        const systemPrompt = agentCfg.system_prompt ?? buildSpecialistPrompt(agentCfg);
        const userPrompt   = [
            subtask.task,
            vaultContext ? `\nRelevant knowledge:\n${vaultContext}` : '',
            priorContext,
        ].filter(Boolean).join('\n');

        return callLLM(provider, systemPrompt, userPrompt);
    }

    /**
     * Cable 2: query active policyRules and match against this subtask.
     * Returns matched rule IDs and the criteria text to show the human approver.
     * No-op when reflection is not configured.
     */
    private async checkActiveRules(
        taskText:    string,
        agentDomain: string | undefined,
    ): Promise<{ matchedRuleIds: string[]; ruleCriteria: string[] }> {
        if (!this.reflection) return { matchedRuleIds: [], ruleCriteria: [] };

        let rules: Awaited<ReturnType<ReflectionAdapter['activeRules']>>;
        try {
            rules = await this.reflection.activeRules({ domain: agentDomain });
        } catch {
            return { matchedRuleIds: [], ruleCriteria: [] };
        }

        const matchedRuleIds: string[] = [];
        const ruleCriteria:   string[] = [];

        for (const rule of rules) {
            if (matchesSubtask(rule, taskText, agentDomain)) {
                matchedRuleIds.push(rule.id);
                ruleCriteria.push(...ruleToGateCriteria(rule));
            }
        }

        return { matchedRuleIds, ruleCriteria };
    }

    private consolidate(plan: TaskPlan, results: ExecutionResult[]): string {
        const successCount = results.filter(r => r.success).length;
        const lines = [
            `## ${plan.summary}`,
            `Completed ${successCount}/${results.length} sub-tasks.`,
            '',
        ];
        for (const r of results) {
            const icon = r.success ? '✓' : '✗';
            lines.push(`**${icon} [${r.agent_id}]** ${r.task.slice(0, 80)}`);
            lines.push(r.result.slice(0, 500));
            lines.push('');
        }
        return lines.join('\n');
    }
}

// ── Rule matching helpers (Cable 2) ───────────────────────────────────────────

type ActiveRule = Awaited<ReturnType<ReflectionAdapter['activeRules']>>[number];

/**
 * Returns true when a policyRule applies to a subtask.
 * Match requires at least one of:
 *   - domain match + keyword hit
 *   - domain match + no keywords (catch-all for that domain)
 *   - no domain specified + keyword hit
 * A rule with neither domain nor keywords is skipped (too broad).
 */
function matchesSubtask(rule: ActiveRule, taskText: string, agentDomain?: string): boolean {
    const cond = rule.if;

    if (cond.domain) {
        if (!agentDomain) return false;
        const domains = Array.isArray(cond.domain) ? cond.domain : [cond.domain];
        if (!domains.includes(agentDomain)) return false;
        // Domain matched — keywords narrow it further; if none, it's a domain catch-all
        if (!cond.keywords?.length) return true;
    }

    if (cond.keywords?.length) {
        const lower = taskText.toLowerCase();
        return cond.keywords.some((kw: string) => lower.includes(kw.toLowerCase()));
    }

    return false; // no domain, no keywords → too broad
}

/**
 * Converts a policyRule's `then` action into human-readable gate criteria.
 * These criteria are shown to the approver alongside the agent's output.
 */
function ruleToGateCriteria(rule: ActiveRule): string[] {
    const a = rule.then;
    const criteria: string[] = [];
    if ((a.mustInclude as string[] | undefined)?.length)
        criteria.push(`Debe incluir: ${(a.mustInclude as string[]).join(', ')}`);
    if ((a.mustPass as string[] | undefined)?.length)
        criteria.push(`Debe cumplir: ${(a.mustPass as string[]).join(', ')}`);
    if ((a.mustExecute as string[] | undefined)?.length)
        criteria.push(`Debe ejecutar: ${(a.mustExecute as string[]).join(', ')}`);
    if (a.requireArchitectureReview) criteria.push('Requiere revisión de arquitectura');
    if (a.requireSecurityReview)     criteria.push('Requiere revisión de seguridad');
    if (a.requireQaApproval)         criteria.push('Requiere aprobación de QA');
    return criteria.length > 0
        ? criteria
        : [`Política "${rule.name}" aplicada — revisión requerida`];
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildSpecialistPrompt(agent: AgentConfig): string {
    return [
        `You are ${agent.name}, a specialist agent.`,
        '',
        `Domain: ${agent.description}`,
        `Capabilities: ${agent.capabilities.join(', ')}`,
        '',
        'Execute the assigned task thoroughly and return a structured, actionable result.',
        'Stay within your domain. If a request is outside your capabilities, say so clearly.',
    ].join('\n');
}

// ── Orchestrator engine (for interactive mode) ────────────────────────────────
// Builds a full AgentEngine with ask_agent tool for direct LLM-driven orchestration.

export function buildOrchestratorEngine(
    opts: ExecutorOptions & { orchestratorProfile: AgentProfile; ragTool?: ReturnType<typeof defineTool> },
): AgentEngine {
    const { config, orchestratorProfile, ragTool, ragSearchFn, onProgress } = opts;

    const executor = new PlanExecutor({ config, ragSearchFn, onProgress });

    const askAgentTool = defineTool({
        name:        'ask_agent',
        description: 'Delegate a task to a configured specialist agent',
        input: z.object({
            agent_id: z.string().describe('ID of the specialist agent from orchestrator.yaml'),
            task:     z.string().describe('Specific task for the specialist to execute'),
        }),
        execute: async ({ agent_id, task }: { agent_id: string; task: string }) => {
            const agentCfg = config.agents.find(a => a.id === agent_id);
            if (!agentCfg) {
                return `No agent with id "${agent_id}". Available: ${config.agents.map(a => a.id).join(', ')}`;
            }
            onProgress?.(`  → delegating to ${agentCfg.name}…`);
            return executor['runSpecialist'](agentCfg, { id: 'x', agent_id, task, depends_on: [] }, []);
        },
    });

    const tools = new ToolRegistry();
    if (ragTool) tools.register(ragTool);
    tools.register(askAgentTool);

    const orchestratorProviderCfg = config.providers[config.orchestrator.provider];
    if (!orchestratorProviderCfg) {
        throw new Error(`Orchestrator provider "${config.orchestrator.provider}" not found in providers config`);
    }

    const providers = new ProviderRegistry();
    providers.register(config.orchestrator.provider, new OpenAICompatibleProvider(orchestratorProviderCfg));

    const agents = new AgentRegistry();
    agents.register(orchestratorProfile);

    const transport = new CallbackTransport((evt: AgentEvent) => {
        if (evt.type === 'tool_call') onProgress?.(`  ● ${evt.name}`);
    });

    return new AgentEngine({
        model:           { provider: config.orchestrator.provider, id: orchestratorProviderCfg.model },
        agents,
        tools,
        providers,
        defaultProvider: config.orchestrator.provider,
        defaultAgentId:  'orchestrator',
        transport,
        maxIterations:   20,
        iterationMode:   'auto',
    });
}
