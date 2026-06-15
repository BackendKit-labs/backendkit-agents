#!/usr/bin/env node

// Load .env from cwd or package root
import * as fsSync   from 'node:fs';
import * as pathSync from 'node:path';
import { fileURLToPath } from 'node:url';
(function loadDotEnv() {
    const pkgRoot    = pathSync.resolve(fileURLToPath(import.meta.url), '..', '..');
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
import { createServer }         from 'node:http';
import { z }                    from 'zod';
import * as path                from 'node:path';
import { loadConfig, resolveDataDir } from './config.js';
import { PoolRegistry }   from './registry.js';
import { FlowExecutor }   from './executor.js';
import { matchFlow }      from './flow.js';
import { RunStore }       from './run-store.js';
import {
    type HandlerCtx,
    dispatch,
    hRunFlow, hStartFlow, hRunTask, hApprove, hReject, hRetry, hStatus, hListAgents, hListAgentsJson, hListRuns,
} from './handlers.js';

// ── Bootstrap ─────────────────────────────────────────────────────────────────

const configPath = process.env['ORCHESTRATOR_CONFIG']
    ?? process.argv[2]
    ?? pathSync.join(process.cwd(), 'orchestrator-mcp.yaml');

const config    = loadConfig(configPath);
const configDir = path.dirname(path.resolve(configPath));
const dataDir   = resolveDataDir(configPath, config);
const registry  = new PoolRegistry(config);
const store     = new RunStore(path.join(dataDir, 'runs.db'));
const executor  = new FlowExecutor({
    registry,
    tenantId:   config.orchestrator.tenant_id,
    onProgress: msg => process.stderr.write(msg + '\n'),
});

const ctx: HandlerCtx = { config, configDir, executor, store, registry };

const log = (msg: string) => process.stderr.write(`[orchestrator-mcp-agent] ${msg}\n`);

// ── HTTP mode ─────────────────────────────────────────────────────────────────

const HTTP_PORT = process.env['ORCHESTRATOR_HTTP_PORT'];

if (HTTP_PORT) {
    const port       = parseInt(HTTP_PORT, 10);
    const httpServer = createServer(async (req, res) => {
        const send = (status: number, body: unknown) => {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(body));
        };

        // Health check
        if (req.method === 'GET' && req.url === '/health') {
            return send(200, { ok: true, name: config.orchestrator.name });
        }

        // Run list
        if (req.method === 'GET' && req.url === '/v1/runs') {
            const runs = await store.list();
            return send(200, runs);
        }

        // Async start: create run and fire execution in background, return run_id immediately
        if (req.method === 'POST' && req.url === '/v1/runs/start') {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(chunk as Buffer);
            try {
                const body = JSON.parse(Buffer.concat(chunks).toString()) as { flow_id: string; input?: Record<string, unknown> };
                const result = JSON.parse(await hStartFlow(ctx, body.flow_id, body.input ?? {})) as { run_id?: string; error?: string };
                return send(result.error ? 400 : 202, result);
            } catch {
                return send(400, { error: 'Invalid JSON body' });
            }
        }

        // Agent health (JSON)
        if (req.method === 'GET' && req.url === '/v1/agents') {
            return send(200, JSON.parse(await hListAgentsJson(ctx)));
        }

        // Tool call
        if (req.method === 'POST' && req.url === '/v1/tools/call') {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(chunk as Buffer);
            let name: string;
            let args: Record<string, unknown>;
            try {
                const body = JSON.parse(Buffer.concat(chunks).toString()) as {
                    name: string;
                    arguments?: Record<string, unknown>;
                };
                name = body.name;
                args = body.arguments ?? {};
            } catch {
                return send(400, { ok: false, error: 'Invalid JSON body' });
            }
            try {
                const result = await dispatch(ctx, name, args);
                return send(200, { ok: true, result });
            } catch (err) {
                return send(200, { ok: false, error: (err as Error).message });
            }
        }

        send(404, { error: 'Not found' });
    });

    httpServer.listen(port, () => {
        log(`${config.orchestrator.name} HTTP on :${port}`);
        log(`agents: ${registry.agentIds().join(', ')}`);
        log(`flows: ${(config.flows ?? []).map(f => f.id).join(', ') || '(none)'}`);
    });

// ── Stdio MCP mode ────────────────────────────────────────────────────────────

} else {
    const ok  = (text: string) => ({ content: [{ type: 'text' as const, text }] });
    const mcp = new McpServer({ name: config.orchestrator.name, version: '0.1.0' });

    mcp.tool('run_flow', 'Trigger a named flow with input data (blocking — waits for completion).', {
        flow_id: z.string().describe('Flow ID as declared in orchestrator-mcp.yaml'),
        input:   z.record(z.unknown()).default({}).describe('Input data for the flow'),
    }, async ({ flow_id, input }) => {
        try { return ok(await hRunFlow(ctx, flow_id, input)); }
        catch (err) { return ok(`Error: ${(err as Error).message}`); }
    });

    mcp.tool('start_flow', 'Start a named flow asynchronously. Returns run_id immediately; poll run_status for progress.', {
        flow_id: z.string().describe('Flow ID as declared in orchestrator-mcp.yaml'),
        input:   z.record(z.unknown()).default({}).describe('Input data for the flow'),
    }, async ({ flow_id, input }) => {
        try { return ok(await hStartFlow(ctx, flow_id, input)); }
        catch (err) { return ok(JSON.stringify({ error: (err as Error).message })); }
    });

    mcp.tool('run_task', 'Run a task — auto-routes to a matching flow based on the task description.', {
        task:  z.string().describe('Task description — used to match a flow trigger'),
        input: z.record(z.unknown()).default({}).describe('Additional input data'),
    }, async ({ task, input }) => {
        try { return ok(await hRunTask(ctx, task, input)); }
        catch (err) { return ok(`Error: ${(err as Error).message}`); }
    });

    mcp.tool('orchestrator_approve', 'Approve a paused gate and resume the flow.', {
        run_id:   z.string().describe('Run ID returned when the gate was hit'),
        feedback: z.string().optional().describe('Optional feedback to pass to subsequent steps'),
    }, async ({ run_id, feedback }) => {
        try { return ok(await hApprove(ctx, run_id, feedback)); }
        catch (err) { return ok(`Error resuming run: ${(err as Error).message}`); }
    });

    mcp.tool('orchestrator_reject', 'Reject a paused gate and cancel the flow.', {
        run_id: z.string().describe('Run ID returned when the gate was hit'),
        reason: z.string().optional().describe('Rejection reason'),
    }, async ({ run_id, reason }) => {
        try { return ok(await hReject(ctx, run_id, reason)); }
        catch (err) { return ok(`Error: ${(err as Error).message}`); }
    });

    mcp.tool('orchestrator_retry', 'Retry a flow paused because a required step failed.', {
        run_id:   z.string().describe('Run ID returned when the required step failed'),
        feedback: z.string().optional().describe('Optional context to pass to the retried step'),
    }, async ({ run_id, feedback }) => {
        try { return ok(await hRetry(ctx, run_id, feedback)); }
        catch (err) { return ok(`Error retrying run: ${(err as Error).message}`); }
    });

    mcp.tool('run_status', 'Check the status of a flow run.', {
        run_id: z.string(),
    }, async ({ run_id }) => {
        try { return ok(await hStatus(ctx, run_id)); }
        catch (err) { return ok(`Error: ${(err as Error).message}`); }
    });

    mcp.tool('list_agents', 'List all registered agents and their health status.', {}, async () => {
        try { return ok(await hListAgents(ctx)); }
        catch (err) { return ok(`Error: ${(err as Error).message}`); }
    });

    mcp.tool('list_agents_json', 'List all registered agents and their health status as JSON.', {}, async () => {
        try { return ok(await hListAgentsJson(ctx)); }
        catch (err) { return ok(`Error: ${(err as Error).message}`); }
    });

    mcp.tool('list_runs', 'List all flow runs with their current status as JSON.', {}, async () => {
        try { return ok(await hListRuns(ctx)); }
        catch (err) { return ok(`Error: ${(err as Error).message}`); }
    });

    const transport = new StdioServerTransport();
    await mcp.connect(transport);
    log(`${config.orchestrator.name} started (stdio)`);
    log(`agents: ${registry.agentIds().join(', ')}`);
    log(`flows: ${(config.flows ?? []).map(f => f.id).join(', ') || '(none)'}`);
}
