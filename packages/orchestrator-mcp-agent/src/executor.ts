import type { AgentContext }  from '@backendkit-labs/agent-protocol';
import type { PoolRegistry }  from './registry.js';
import type { Flow, FlowStep } from './flow.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface StepResult {
    stepId:     string;
    agentId:    string;
    capability: string;
    task?:      string;
    output:     string;
    success:    boolean;
    durationMs: number;
}

export interface GateHit {
    gateRequired:   true;
    stepId:         string;
    agentId:        string;
    output:         string;
    criteria:       string[];
    completedSoFar: StepResult[];
    pendingSteps:   string[];
}

export interface StepFailed {
    stepFailed:     true;
    stepId:         string;
    agentId:        string;
    error:          string;
    completedSoFar: StepResult[];   // only successful steps before the failure
    pendingSteps:   string[];
}

export interface FlowResult {
    flowId:    string;
    steps:     StepResult[];
    summary:   string;
    complete:  boolean;
}

export interface ExecutorOptions {
    registry:   PoolRegistry;
    tenantId?:  string;
    onProgress?: (msg: string) => void;
}

// ── Executor ──────────────────────────────────────────────────────────────────

export class FlowExecutor {
    private readonly registry:   PoolRegistry;
    private readonly tenantId?:  string;
    private readonly onProgress: (msg: string) => void;

    constructor(opts: ExecutorOptions) {
        this.registry   = opts.registry;
        this.tenantId   = opts.tenantId;
        this.onProgress = opts.onProgress ?? (() => {});
    }

    async execute(
        flow:         Flow,
        input:        Record<string, unknown> = {},
        priorResults: StepResult[] = [],
        onStepStart?: (stepId: string, agentId: string, task: string) => Promise<void>,
    ): Promise<FlowResult | GateHit | StepFailed> {
        const context: AgentContext = {
            tenantId:  this.tenantId,
            traceId:   `${flow.id}-${Date.now()}`,
            requestId: crypto.randomUUID(),
        };

        // Steps already in completed are skipped — covers both gate resume and retry resume.
        const completed = new Map<string, StepResult>(priorResults.map(r => [r.stepId, r]));

        for (const step of flow.steps) {
            if (completed.has(step.id)) continue;

            // Wait for dependencies
            for (const depId of step.depends_on) {
                if (!completed.has(depId)) {
                    return this.makeResult(flow.id, [...completed.values()], false, 'Dependency not met');
                }
            }

            this.onProgress(`[${flow.id}] step ${step.id} → agent ${step.agentId ?? step.agent}`);
            if (onStepStart) await onStepStart(step.id, step.agent, step.task ?? '');

            const result = await this.runStep(step, input, completed, context);
            const pending = flow.steps.slice(flow.steps.indexOf(step) + 1).map(s => s.id);

            // Required step failed → pause flow until orchestrator_retry
            if (!result.success && (step.required ?? false)) {
                return {
                    stepFailed:     true,
                    stepId:         step.id,
                    agentId:        step.agent,
                    error:          result.output,
                    completedSoFar: [...completed.values()],  // successful steps only (failed not added yet)
                    pendingSteps:   pending,
                };
            }

            completed.set(step.id, result);

            // Gate check
            const agentCfg = this.registry.config(step.agent);
            const hasGate  = step.gate ?? agentCfg.gate ?? false;

            if (hasGate) {
                const criteria = step.gate_criteria ?? agentCfg.gate_criteria ?? [];
                return {
                    gateRequired:   true,
                    stepId:         step.id,
                    agentId:        step.agent,
                    output:         result.output,
                    criteria,
                    completedSoFar: [...completed.values()],
                    pendingSteps:   pending,
                };
            }
        }

        const allResults = [...completed.values()];
        const summary    = this.summarize(allResults);
        return this.makeResult(flow.id, allResults, true, summary);
    }

    // ── Step execution ────────────────────────────────────────────────────────

    private async runStep(
        step:      FlowStep,
        flowInput: Record<string, unknown>,
        prior:     Map<string, StepResult>,
        context:   AgentContext,
    ): Promise<StepResult> {
        const start      = Date.now();
        const pool       = this.registry.get(step.agent);
        const agentCfg   = this.registry.config(step.agent);
        const capability = step.capability ?? agentCfg.capability;

        // Build input: merge flow input + prior results + step-specific input
        const priorContext = [...prior.values()].map(r => ({
            step:   r.stepId,
            agent:  r.agentId,
            output: r.output,
        }));

        const callInput: Record<string, unknown> = {
            task:           step.task,
            flow_input:     flowInput,
            prior_results:  priorContext,
            ...(step.input ?? {}),
        };

        try {
            const raw    = await pool.runAndWait(capability, callInput, { context });
            const output = extractOutput(raw);

            return {
                stepId:     step.id,
                agentId:    step.agent,
                capability,
                task:       step.task,
                output,
                success:    true,
                durationMs: Date.now() - start,
            };
        } catch (err) {
            const output = `ERROR: ${(err as Error).message}`;
            return {
                stepId:     step.id,
                agentId:    step.agent,
                capability,
                task:       step.task,
                output,
                success:    false,
                durationMs: Date.now() - start,
            };
        }
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private makeResult(flowId: string, steps: StepResult[], complete: boolean, summary: string): FlowResult {
        return { flowId, steps, summary, complete };
    }

    private summarize(steps: StepResult[]): string {
        const ok  = steps.filter(s => s.success).length;
        const err = steps.filter(s => !s.success).length;
        const lines = steps.map(s => `[${s.success ? '✓' : '✗'}] ${s.stepId} (${s.agentId}): ${s.output.slice(0, 200)}`);
        return [`Flow complete — ${ok} ok, ${err} errors`, ...lines].join('\n');
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractOutput(raw: unknown): string {
    if (typeof raw === 'string') return raw;
    if (raw && typeof raw === 'object') {
        const r = raw as Record<string, unknown>;
        if (typeof r['output'] === 'string') return r['output'];
        if (typeof r['result'] === 'string') return r['result'];
        if (typeof r['text'] === 'string')   return r['text'];
        return JSON.stringify(raw);
    }
    return String(raw);
}
