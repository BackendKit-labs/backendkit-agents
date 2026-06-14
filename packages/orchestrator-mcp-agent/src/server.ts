#!/usr/bin/env node

// Load .env from cwd or package root
import * as fsSync   from 'node:fs';
import * as pathSync from 'node:path';
import { fileURLToPath } from 'node:url';
(function loadDotEnv() {
    const pkgRoot  = pathSync.resolve(fileURLToPath(import.meta.url), '..', '..');
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

import { McpServer }            from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z }                    from 'zod';
import * as path                from 'node:path';
import { loadConfig, resolveDataDir } from './config.js';
import { PoolRegistry }         from './registry.js';
import { FlowExecutor }         from './executor.js';
import { matchFlow, loadFlow }  from './flow.js';
import { RunStore }             from './run-store.js';
import type { RunState }        from './run-store.js';
import type { GateHit, FlowResult, StepFailed } from './executor.js';

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const configPath = process.env['ORCHESTRATOR_CONFIG']
    ?? process.argv[2]
    ?? pathSync.join(process.cwd(), 'orchestrator-mcp.yaml');

const config   = loadConfig(configPath);
const configDir = path.dirname(path.resolve(configPath));
const dataDir   = resolveDataDir(configPath, config);
const registry  = new PoolRegistry(config);
const store     = new RunStore(path.join(dataDir, 'runs'));
const executor  = new FlowExecutor({
    registry,
    tenantId:   config.orchestrator.tenant_id,
    onProgress: msg => process.stderr.write(msg + '\n'),
});

// ── Helpers ───────────────────────────────────────────────────────────────────

const ok  = (text: string) => ({ content: [{ type: 'text' as const, text }] });
const ts  = () => new Date().toISOString();

function isGate(r: FlowResult | GateHit | StepFailed): r is GateHit {
    return (r as GateHit).gateRequired === true;
}

function isStepFailed(r: FlowResult | GateHit | StepFailed): r is StepFailed {
    return (r as StepFailed).stepFailed === true;
}

async function executeAndPersist(
    flowId:    string,
    flowFile:  string,
    input:     Record<string, unknown>,
    runId?:    string,
): Promise<string> {
    const flow = loadFlow(path.resolve(configDir, flowFile));
    const run  = store.newRun(flowId, input);
    if (runId) run.id = runId;
    await store.save(run);

    const result = await executor.execute(flow, input);

    if (isGate(result)) {
        Object.assign(run, {
            status:      'waiting_gate',
            results:     result.completedSoFar,
            gateStepId:  result.stepId,
            updatedAt:   ts(),
        });
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
        Object.assign(run, {
            status:        'waiting_retry',
            results:       result.completedSoFar,
            failedStepId:  result.stepId,
            error:         result.error,
            updatedAt:     ts(),
        });
        await store.save(run);
        return [
            `✗ Required step "${result.stepId}" (agent: ${result.agentId}) failed`,
            `Run ID: ${run.id}`,
            `\nError: ${result.error}`,
            `\nWhen the agent recovers, retry with:`,
            `orchestrator_retry(run_id="${run.id}")`,
        ].join('\n');
    }

    Object.assign(run, {
        status:    result.complete ? 'done' : 'failed',
        results:   result.steps,
        summary:   result.summary,
        updatedAt: ts(),
    });
    await store.save(run);
    return result.summary;
}

// ── MCP Server ────────────────────────────────────────────────────────────────

const server = new McpServer({
    name:    config.orchestrator.name,
    version: '0.1.0',
});

// ── Tool: run_flow ─────────────────────────────────────────────────────────────

server.tool(
    'run_flow',
    'Trigger a named flow with input data.',
    {
        flow_id: z.string().describe('Flow ID as declared in orchestrator-mcp.yaml'),
        input:   z.record(z.unknown()).default({}).describe('Input data for the flow'),
    },
    async ({ flow_id, input }) => {
        const entry = (config.flows ?? []).find(f => f.id === flow_id);
        if (!entry) {
            const ids = (config.flows ?? []).map(f => f.id).join(', ');
            return ok(`Flow '${flow_id}' not found. Available: ${ids || '(none)'}`);
        }
        try {
            return ok(await executeAndPersist(entry.id, entry.file, input));
        } catch (err) {
            return ok(`Error: ${(err as Error).message}`);
        }
    },
);

// ── Tool: run_task ─────────────────────────────────────────────────────────────

server.tool(
    'run_task',
    'Run a task — auto-routes to a matching flow based on the task description.',
    {
        task:  z.string().describe('Task description — used to match a flow trigger'),
        input: z.record(z.unknown()).default({}).describe('Additional input data'),
    },
    async ({ task, input }) => {
        const match = matchFlow(config.flows ?? [], configDir, task);
        if (!match) {
            return ok([
                `No flow matched task: "${task}"`,
                `Available flows: ${(config.flows ?? []).map(f => `${f.id} (trigger: ${f.trigger ?? 'manual'})`).join(', ') || '(none)'}`,
            ].join('\n'));
        }
        try {
            return ok(await executeAndPersist(match.id, match.flow.id, { ...input, task }));
        } catch (err) {
            return ok(`Error: ${(err as Error).message}`);
        }
    },
);

// ── Tool: orchestrator_approve ─────────────────────────────────────────────────

server.tool(
    'orchestrator_approve',
    'Approve a paused gate and resume the flow.',
    {
        run_id:   z.string().describe('Run ID returned when the gate was hit'),
        feedback: z.string().optional().describe('Optional feedback to pass to subsequent steps'),
    },
    async ({ run_id, feedback }) => {
        const run = await store.get(run_id);
        if (!run) return ok(`Run '${run_id}' not found`);
        if (run.status !== 'waiting_gate') return ok(`Run '${run_id}' is not waiting for approval (status: ${run.status})`);

        const entry = (config.flows ?? []).find(f => f.id === run.flowId);
        if (!entry) return ok(`Flow '${run.flowId}' not found in config`);

        try {
            const flow   = loadFlow(path.resolve(configDir, entry.file));
            const input  = { ...run.input, ...(feedback ? { approval_feedback: feedback } : {}) };
            const result = await executor.execute(flow, input, run.results);

            if (isGate(result)) {
                Object.assign(run, {
                    results:    result.completedSoFar,
                    gateStepId: result.stepId,
                    updatedAt:  ts(),
                });
                await store.save(run);
                return ok([
                    `⏸ Next gate at step "${result.stepId}" (agent: ${result.agentId})`,
                    `\nOutput:\n${result.output}`,
                    result.criteria.length ? `\nCriteria:\n${result.criteria.map(c => `  • ${c}`).join('\n')}` : '',
                    `\nApprove: orchestrator_approve(run_id="${run_id}")`,
                ].filter(Boolean).join('\n'));
            }

            if (isStepFailed(result)) {
                Object.assign(run, {
                    status:       'waiting_retry',
                    results:      result.completedSoFar,
                    failedStepId: result.stepId,
                    error:        result.error,
                    updatedAt:    ts(),
                });
                await store.save(run);
                return ok([
                    `✗ Required step "${result.stepId}" (agent: ${result.agentId}) failed`,
                    `\nError: ${result.error}`,
                    `\nWhen the agent recovers, retry with:`,
                    `orchestrator_retry(run_id="${run_id}")`,
                ].join('\n'));
            }

            Object.assign(run, {
                status:    result.complete ? 'done' : 'failed',
                results:   result.steps,
                summary:   result.summary,
                updatedAt: ts(),
            });
            await store.save(run);
            return ok(result.summary);
        } catch (err) {
            return ok(`Error resuming run: ${(err as Error).message}`);
        }
    },
);

// ── Tool: orchestrator_retry ───────────────────────────────────────────────────

server.tool(
    'orchestrator_retry',
    'Retry a flow paused because a required step failed. Use when the failing agent has recovered.',
    {
        run_id:   z.string().describe('Run ID returned when the required step failed'),
        feedback: z.string().optional().describe('Optional context to pass to the retried step'),
    },
    async ({ run_id, feedback }) => {
        const run = await store.get(run_id);
        if (!run) return ok(`Run '${run_id}' not found`);
        if (run.status !== 'waiting_retry') return ok(`Run '${run_id}' is not waiting for retry (status: ${run.status})`);

        const entry = (config.flows ?? []).find(f => f.id === run.flowId);
        if (!entry) return ok(`Flow '${run.flowId}' not found in config`);

        try {
            const flow   = loadFlow(path.resolve(configDir, entry.file));
            const input  = { ...run.input, ...(feedback ? { retry_feedback: feedback } : {}) };
            // run.results contains only the successful steps before the failure;
            // the failed step is not in the list, so executor will re-run it.
            const result = await executor.execute(flow, input, run.results);

            if (isStepFailed(result)) {
                Object.assign(run, {
                    results:      result.completedSoFar,
                    failedStepId: result.stepId,
                    error:        result.error,
                    updatedAt:    ts(),
                });
                await store.save(run);
                return ok([
                    `✗ Step "${result.stepId}" (agent: ${result.agentId}) failed again`,
                    `\nError: ${result.error}`,
                    `\nRetry again with: orchestrator_retry(run_id="${run_id}")`,
                ].join('\n'));
            }

            if (isGate(result)) {
                Object.assign(run, {
                    status:    'waiting_gate',
                    results:   result.completedSoFar,
                    gateStepId: result.stepId,
                    updatedAt: ts(),
                });
                await store.save(run);
                return ok([
                    `⏸ Gate reached at step "${result.stepId}" (agent: ${result.agentId})`,
                    `\nOutput:\n${result.output}`,
                    result.criteria.length ? `\nCriteria:\n${result.criteria.map(c => `  • ${c}`).join('\n')}` : '',
                    `\nApprove: orchestrator_approve(run_id="${run_id}")`,
                ].filter(Boolean).join('\n'));
            }

            Object.assign(run, {
                status:    result.complete ? 'done' : 'failed',
                results:   result.steps,
                summary:   result.summary,
                updatedAt: ts(),
            });
            await store.save(run);
            return ok(result.summary);
        } catch (err) {
            return ok(`Error retrying run: ${(err as Error).message}`);
        }
    },
);

// ── Tool: orchestrator_reject ──────────────────────────────────────────────────

server.tool(
    'orchestrator_reject',
    'Reject a paused gate and cancel the flow.',
    {
        run_id:  z.string().describe('Run ID returned when the gate was hit'),
        reason:  z.string().optional().describe('Rejection reason'),
    },
    async ({ run_id, reason }) => {
        const run = await store.get(run_id);
        if (!run) return ok(`Run '${run_id}' not found`);
        if (run.status !== 'waiting_gate') return ok(`Run '${run_id}' is not waiting for approval (status: ${run.status})`);

        Object.assign(run, { status: 'cancelled', error: reason ?? 'Rejected by operator', updatedAt: ts() });
        await store.save(run);
        return ok(`Flow '${run.flowId}' cancelled${reason ? `: ${reason}` : ''}`);
    },
);

// ── Tool: run_status ───────────────────────────────────────────────────────────

server.tool(
    'run_status',
    'Check the status of a flow run.',
    { run_id: z.string() },
    async ({ run_id }) => {
        const run = await store.get(run_id);
        if (!run) return ok(`Run '${run_id}' not found`);
        const lines = [
            `Run:    ${run.id}`,
            `Flow:   ${run.flowId}`,
            `Status: ${run.status}`,
            `Steps:  ${run.results.length} completed`,
            run.gateStepId ? `Gate:   waiting at step "${run.gateStepId}"` : '',
            run.summary    ? `\nSummary:\n${run.summary}` : '',
            run.error      ? `\nError: ${run.error}` : '',
        ];
        return ok(lines.filter(Boolean).join('\n'));
    },
);

// ── Tool: list_agents ──────────────────────────────────────────────────────────

server.tool(
    'list_agents',
    'List all registered agents and their health status.',
    {},
    async () => {
        const health = await registry.healthAll();
        const lines  = registry.agentIds().map(id => {
            const cfg       = registry.config(id);
            const instances = health[id] ?? [];
            const statusStr = instances.map(i => `    ${i.url} [${i.ok ? 'ok' : 'down'}] circuit=${i.circuitState}`).join('\n');
            return [`Agent: ${id} (${cfg.description ?? ''}) — strategy: ${cfg.strategy}`, statusStr].join('\n');
        });
        return ok(lines.join('\n\n') || 'No agents registered');
    },
);

// ── Start ─────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write(`[orchestrator-mcp-agent] ${config.orchestrator.name} started\n`);
process.stderr.write(`[orchestrator-mcp-agent] agents: ${registry.agentIds().join(', ')}\n`);
process.stderr.write(`[orchestrator-mcp-agent] flows: ${(config.flows ?? []).map(f => f.id).join(', ') || '(none)'}\n`);
