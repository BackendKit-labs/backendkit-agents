import * as path from 'node:path';
import { matchFlow, loadFlow } from './flow.js';
import type { FlowExecutor, GateHit, FlowResult, StepFailed } from './executor.js';
import type { RunStore }     from './run-store.js';
import type { PoolRegistry } from './registry.js';
import type { OrchestratorMcpConfig } from './config.js';

export interface HandlerCtx {
    config:    OrchestratorMcpConfig;
    configDir: string;
    executor:  FlowExecutor;
    store:     RunStore;
    registry:  PoolRegistry;
}

const ts = () => new Date().toISOString();

// ── Concurrency guards ────────────────────────────────────────────────────────

// Prevents double-processing the same run (e.g. two operators approve simultaneously)
const inFlight = new Set<string>();

// Limits concurrent LLM executions to avoid API rate-limit bursts
class Semaphore {
    private count: number;
    private readonly queue: Array<() => void> = [];
    constructor(max: number) { this.count = max; }
    acquire(): Promise<void> {
        return new Promise<void>(resolve => {
            if (this.count > 0) {
                this.count--;
                resolve();
            } else {
                this.queue.push(resolve);
            }
        });
    }
    release(): void {
        const next = this.queue.shift();
        if (next) next();
        else this.count++;
    }
}

const execSemaphore = new Semaphore(Number(process.env['MAX_CONCURRENT_FLOWS'] ?? 3));

// ─────────────────────────────────────────────────────────────────────────────

function isGate(r: FlowResult | GateHit | StepFailed): r is GateHit {
    return (r as GateHit).gateRequired === true;
}
function isStepFailed(r: FlowResult | GateHit | StepFailed): r is StepFailed {
    return (r as StepFailed).stepFailed === true;
}

async function executeAndPersist(
    ctx:      HandlerCtx,
    flowId:   string,
    flowFile: string,
    input:    Record<string, unknown>,
): Promise<string> {
    const { configDir, executor, store } = ctx;
    const flow = loadFlow(path.resolve(configDir, flowFile));
    const run  = store.newRun(flowId, input);
    await store.save(run);

    const result = await executor.execute(flow, input);

    if (isGate(result)) {
        Object.assign(run, { status: 'waiting_gate', results: result.completedSoFar, gateStepId: result.stepId, updatedAt: ts() });
        await store.save(run);
        return [
            `⏸ Gate reached at step "${result.stepId}" (agent: ${result.agentId})`,
            `Run ID: ${run.id}`,
            `\nAgent output:\n${result.output}`,
            result.criteria.length ? `\nCriteria:\n${result.criteria.map(c => `  • ${c}`).join('\n')}` : '',
            `\nApprove: orchestrator_approve(run_id="${run.id}")`,
            `Reject:  orchestrator_reject(run_id="${run.id}")`,
        ].filter(Boolean).join('\n');
    }

    if (isStepFailed(result)) {
        Object.assign(run, { status: 'waiting_retry', results: result.completedSoFar, failedStepId: result.stepId, error: result.error, updatedAt: ts() });
        await store.save(run);
        return [
            `✗ Required step "${result.stepId}" (agent: ${result.agentId}) failed`,
            `Run ID: ${run.id}`,
            `\nError: ${result.error}`,
            `\nRetry with: orchestrator_retry(run_id="${run.id}")`,
        ].join('\n');
    }

    Object.assign(run, { status: result.complete ? 'done' : 'failed', results: result.steps, summary: result.summary, updatedAt: ts() });
    await store.save(run);
    return result.summary;
}

// ── Public handlers ────────────────────────────────────────────────────────────

export async function hRunFlow(ctx: HandlerCtx, flowId: string, input: Record<string, unknown>): Promise<string> {
    const entry = (ctx.config.flows ?? []).find(f => f.id === flowId);
    if (!entry) {
        const ids = (ctx.config.flows ?? []).map(f => f.id).join(', ');
        return `Flow '${flowId}' not found. Available: ${ids || '(none)'}`;
    }
    return executeAndPersist(ctx, entry.id, entry.file, input);
}

export async function hRunTask(ctx: HandlerCtx, task: string, input: Record<string, unknown>): Promise<string> {
    const match = matchFlow(ctx.config.flows ?? [], ctx.configDir, task);
    if (!match) {
        return [
            `No flow matched task: "${task}"`,
            `Available: ${(ctx.config.flows ?? []).map(f => `${f.id} (trigger: ${f.trigger ?? 'manual'})`).join(', ') || '(none)'}`,
        ].join('\n');
    }
    return executeAndPersist(ctx, match.id, match.flow.id, { ...input, task });
}

export async function hApprove(ctx: HandlerCtx, runId: string, feedback?: string): Promise<string> {
    if (inFlight.has(runId)) return `Run '${runId}' is already being processed`;
    inFlight.add(runId);
    try {
        const { config, configDir, executor, store } = ctx;
        const run = await store.get(runId);
        if (!run) return `Run '${runId}' not found`;
        if (run.status !== 'waiting_gate') return `Run '${runId}' is not waiting for approval (status: ${run.status})`;

        const entry = (config.flows ?? []).find(f => f.id === run.flowId);
        if (!entry) return `Flow '${run.flowId}' not found in config`;

        Object.assign(run, { status: 'running', gateStepId: undefined, updatedAt: ts() });
        await store.save(run);

        const flow  = loadFlow(path.resolve(configDir, entry.file));
        const input = { ...run.input, ...(feedback ? { approval_feedback: feedback } : {}) };

        await execSemaphore.acquire();
        try {
            const onStepStart = async (stepId: string) => {
                Object.assign(run, { currentStepId: stepId, updatedAt: ts() });
                await store.save(run);
            };
            const result = await executor.execute(flow, input, run.results, onStepStart);

            if (isGate(result)) {
                Object.assign(run, { status: 'waiting_gate', currentStepId: undefined, results: result.completedSoFar, gateStepId: result.stepId, gateCriteria: result.criteria, updatedAt: ts() });
                await store.save(run);
                return [
                    `⏸ Next gate at step "${result.stepId}" (agent: ${result.agentId})`,
                    `\nOutput:\n${result.output}`,
                    result.criteria.length ? `\nCriteria:\n${result.criteria.map(c => `  • ${c}`).join('\n')}` : '',
                    `\nApprove: orchestrator_approve(run_id="${runId}")`,
                ].filter(Boolean).join('\n');
            }

            if (isStepFailed(result)) {
                Object.assign(run, { status: 'waiting_retry', currentStepId: undefined, results: result.completedSoFar, failedStepId: result.stepId, error: result.error, updatedAt: ts() });
                await store.save(run);
                return [`✗ Required step "${result.stepId}" (agent: ${result.agentId}) failed`, `\nError: ${result.error}`, `\nRetry: orchestrator_retry(run_id="${runId}")`].join('\n');
            }

            Object.assign(run, { status: result.complete ? 'done' : 'failed', currentStepId: undefined, results: result.steps, summary: result.summary, updatedAt: ts() });
            await store.save(run);
            return result.summary;
        } finally {
            execSemaphore.release();
        }
    } finally {
        inFlight.delete(runId);
    }
}

export async function hReject(ctx: HandlerCtx, runId: string, reason?: string): Promise<string> {
    const run = await ctx.store.get(runId);
    if (!run) return `Run '${runId}' not found`;
    if (run.status !== 'waiting_gate') return `Run '${runId}' is not waiting for approval (status: ${run.status})`;
    Object.assign(run, { status: 'cancelled', error: reason ?? 'Rejected by operator', updatedAt: ts() });
    await ctx.store.save(run);
    return `Flow '${run.flowId}' cancelled${reason ? `: ${reason}` : ''}`;
}

export async function hRetry(ctx: HandlerCtx, runId: string, feedback?: string): Promise<string> {
    if (inFlight.has(runId)) return `Run '${runId}' is already being processed`;
    inFlight.add(runId);
    try {
        const { config, configDir, executor, store } = ctx;
        const run = await store.get(runId);
        if (!run) return `Run '${runId}' not found`;
        if (run.status !== 'waiting_retry') return `Run '${runId}' is not waiting for retry (status: ${run.status})`;

        const entry = (config.flows ?? []).find(f => f.id === run.flowId);
        if (!entry) return `Flow '${run.flowId}' not found in config`;

        Object.assign(run, { status: 'running', failedStepId: undefined, updatedAt: ts() });
        await store.save(run);

        const flow  = loadFlow(path.resolve(configDir, entry.file));
        const input = { ...run.input, ...(feedback ? { retry_feedback: feedback } : {}) };

        await execSemaphore.acquire();
        try {
            const onStepStart = async (stepId: string) => {
                Object.assign(run, { currentStepId: stepId, updatedAt: ts() });
                await store.save(run);
            };
            const result = await executor.execute(flow, input, run.results, onStepStart);

            if (isStepFailed(result)) {
                Object.assign(run, { status: 'waiting_retry', currentStepId: undefined, results: result.completedSoFar, failedStepId: result.stepId, error: result.error, updatedAt: ts() });
                await store.save(run);
                return [`✗ Step "${result.stepId}" failed again`, `\nError: ${result.error}`, `\nRetry: orchestrator_retry(run_id="${runId}")`].join('\n');
            }

            if (isGate(result)) {
                Object.assign(run, { status: 'waiting_gate', currentStepId: undefined, results: result.completedSoFar, gateStepId: result.stepId, gateCriteria: result.criteria, updatedAt: ts() });
                await store.save(run);
                return [
                    `⏸ Gate at step "${result.stepId}" (agent: ${result.agentId})`,
                    `\nOutput:\n${result.output}`,
                    `\nApprove: orchestrator_approve(run_id="${runId}")`,
                ].join('\n');
            }

            Object.assign(run, { status: result.complete ? 'done' : 'failed', currentStepId: undefined, results: result.steps, summary: result.summary, updatedAt: ts() });
            await store.save(run);
            return result.summary;
        } finally {
            execSemaphore.release();
        }
    } finally {
        inFlight.delete(runId);
    }
}

export async function hStatus(ctx: HandlerCtx, runId: string): Promise<string> {
    const run = await ctx.store.get(runId);
    if (!run) return `Run '${runId}' not found`;
    return [
        `Run:    ${run.id}`,
        `Flow:   ${run.flowId}`,
        `Status: ${run.status}`,
        `Steps:  ${run.results.length} completed`,
        run.gateStepId ? `Gate:   waiting at step "${run.gateStepId}"` : '',
        run.summary    ? `\nSummary:\n${run.summary}` : '',
        run.error      ? `\nError: ${run.error}` : '',
    ].filter(Boolean).join('\n');
}

export async function hListAgents(ctx: HandlerCtx): Promise<string> {
    const health = await ctx.registry.healthAll();
    const lines  = ctx.registry.agentIds().map(id => {
        const cfg       = ctx.registry.config(id);
        const instances = health[id] ?? [];
        const statusStr = instances.map(i => `    ${i.url} [${i.ok ? 'ok' : 'down'}] circuit=${i.circuitState}`).join('\n');
        return [`Agent: ${id} (${cfg.description ?? ''}) — strategy: ${cfg.strategy}`, statusStr].join('\n');
    });
    return lines.join('\n\n') || 'No agents registered';
}

export async function hListAgentsJson(ctx: HandlerCtx): Promise<string> {
    const health = await ctx.registry.healthAll();
    const agents = ctx.registry.agentIds().map(id => {
        const cfg = ctx.registry.config(id);
        return {
            id,
            description: cfg.description ?? '',
            strategy:    cfg.strategy,
            instances:   (health[id] ?? []).map(i => ({ url: i.url, ok: i.ok, circuitState: i.circuitState })),
        };
    });
    return JSON.stringify(agents);
}

export async function hListRuns(ctx: HandlerCtx): Promise<string> {
    const runs = await ctx.store.list();
    return JSON.stringify(runs);
}

// Async variant: creates run, fires execution in background, returns run_id immediately
export async function hStartFlow(ctx: HandlerCtx, flowId: string, input: Record<string, unknown>): Promise<string> {
    const entry = (ctx.config.flows ?? []).find(f => f.id === flowId);
    if (!entry) {
        const ids = (ctx.config.flows ?? []).map(f => f.id).join(', ');
        return JSON.stringify({ error: `Flow '${flowId}' not found. Available: ${ids || '(none)'}` });
    }

    const { executor, store, configDir } = ctx;
    const flow = loadFlow(path.resolve(configDir, entry.file));
    const run  = store.newRun(flowId, input);
    await store.save(run);

    setImmediate(async () => {
        await execSemaphore.acquire();
        try {
            const onStepStart = async (stepId: string) => {
                Object.assign(run, { currentStepId: stepId, updatedAt: ts() });
                await store.save(run);
            };
            const result = await executor.execute(flow, input, [], onStepStart);
            if (isGate(result)) {
                Object.assign(run, { status: 'waiting_gate', currentStepId: undefined, results: result.completedSoFar, gateStepId: result.stepId, gateCriteria: result.criteria, updatedAt: ts() });
            } else if (isStepFailed(result)) {
                Object.assign(run, { status: 'waiting_retry', currentStepId: undefined, results: result.completedSoFar, failedStepId: result.stepId, error: result.error, updatedAt: ts() });
            } else {
                Object.assign(run, { status: result.complete ? 'done' : 'failed', currentStepId: undefined, results: result.steps, summary: result.summary, updatedAt: ts() });
            }
        } catch (err) {
            Object.assign(run, { status: 'failed', currentStepId: undefined, error: (err as Error).message, updatedAt: ts() });
        } finally {
            execSemaphore.release();
        }
        await store.save(run).catch((e: Error) => process.stderr.write(`[hStartFlow] save error: ${e.message}\n`));
    });

    return JSON.stringify({ run_id: run.id, status: 'running' });
}

// ── Dispatcher (used by HTTP server) ──────────────────────────────────────────

export async function dispatch(ctx: HandlerCtx, name: string, args: Record<string, unknown>): Promise<string> {
    switch (name) {
        case 'run_flow':           return hRunFlow(ctx, String(args['flow_id'] ?? ''), (args['input'] ?? {}) as Record<string, unknown>);
        case 'start_flow':         return hStartFlow(ctx, String(args['flow_id'] ?? ''), (args['input'] ?? {}) as Record<string, unknown>);
        case 'run_task':           return hRunTask(ctx, String(args['task'] ?? ''), (args['input'] ?? {}) as Record<string, unknown>);
        case 'orchestrator_approve': return hApprove(ctx, String(args['run_id'] ?? ''), args['feedback'] as string | undefined);
        case 'orchestrator_reject':  return hReject(ctx, String(args['run_id'] ?? ''), args['reason'] as string | undefined);
        case 'orchestrator_retry':   return hRetry(ctx, String(args['run_id'] ?? ''), args['feedback'] as string | undefined);
        case 'run_status':         return hStatus(ctx, String(args['run_id'] ?? ''));
        case 'list_agents':        return hListAgents(ctx);
        case 'list_agents_json':   return hListAgentsJson(ctx);
        case 'list_runs':          return hListRuns(ctx);
        default: throw new Error(`Unknown tool: ${name}`);
    }
}
