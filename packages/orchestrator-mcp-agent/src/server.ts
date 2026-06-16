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
import { loadFlow }       from './flow.js';
import { RunStore }       from './run-store.js';
import { ConfigStore }    from './config-store.js';
import type { StoredAgent, StoredFlow } from './config-store.js';
import { DockerRuntime }     from './runtime.js';
import { KubernetesRuntime } from './k8s-runtime.js';
import type { DeploySpec, AgentRuntime } from './runtime.js';
import {
    type HandlerCtx,
    dispatch,
    hRunFlow, hStartFlow, hRunTask, hApprove, hReject, hRetry, hStatus,
    hListAgents, hListAgentsJson, hListRuns, hGetConfig,
    hSaveAgent, hDeleteAgent, hSaveFlow, hDeleteFlow,
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

// ── ConfigStore — seed from YAML on first run ─────────────────────────────────

const configStore = new ConfigStore(path.join(dataDir, 'config.db'));

if (configStore.isEmpty()) {
    const yamlFlows: StoredFlow[] = (config.flows ?? []).flatMap(entry => {
        try {
            const f = loadFlow(path.resolve(configDir, entry.file));
            return [{
                id:          entry.id,
                name:        f.name,
                description: f.description,
                trigger:     entry.trigger,
                steps:       f.steps.map((s, i) => ({
                    id:            s.id,
                    agent:         s.agent,
                    task:          s.task,
                    capability:    s.capability,
                    input:         s.input,
                    depends_on:    s.depends_on,
                    gate:          s.gate ?? false,
                    gate_criteria: s.gate_criteria,
                    required:      s.required ?? false,
                    position:      i,
                })),
            }];
        } catch { return []; }
    });
    configStore.seedFromYaml(config, yamlFlows);
}

const ctx: HandlerCtx = { config, configDir, executor, store, registry, configStore };

const log = (msg: string) => process.stderr.write(`[orchestrator-mcp-agent] ${msg}\n`);

// ── Docker runtime (optional — only used when Docker is available) ─────────────

// DEPLOY_RUNTIME=kubernetes → KubernetesRuntime, default → DockerRuntime
// K8s options via env: K8S_NAMESPACE, K8S_SERVICE_TYPE (NodePort|LoadBalancer|ClusterIP),
//                      K8S_NODE_HOST, K8S_IN_CLUSTER=true

let dockerRuntime: AgentRuntime | null = null;
try {
    const runtimeType = process.env['DEPLOY_RUNTIME'] ?? 'docker';
    if (runtimeType === 'kubernetes') {
        dockerRuntime = new KubernetesRuntime({
            namespace:   process.env['K8S_NAMESPACE']    ?? 'mcp-agents',
            serviceType: (process.env['K8S_SERVICE_TYPE'] as 'NodePort' | 'LoadBalancer' | 'ClusterIP') ?? 'NodePort',
            nodeHost:    process.env['K8S_NODE_HOST']    ?? 'localhost',
            inCluster:   process.env['K8S_IN_CLUSTER']  === 'true',
        });
        log('deploy runtime: kubernetes');
    } else {
        dockerRuntime = new DockerRuntime();
        log('deploy runtime: docker');
    }
} catch (e) {
    log(`deploy runtime unavailable: ${(e as Error).message} — /v1/deploy endpoints disabled`);
}

// ── HTTP mode ─────────────────────────────────────────────────────────────────

const HTTP_PORT = process.env['ORCHESTRATOR_HTTP_PORT'];

if (HTTP_PORT) {
    const port       = parseInt(HTTP_PORT, 10);
    const httpServer = createServer(async (req, res) => {
        const send = (status: number, body: unknown) => {
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(body));
        };

        const readBody = async (): Promise<unknown> => {
            const chunks: Buffer[] = [];
            for await (const chunk of req) chunks.push(chunk as Buffer);
            return JSON.parse(Buffer.concat(chunks).toString());
        };

        const url = req.url ?? '/';

        if (req.method === 'GET'  && url === '/health')   return send(200, { ok: true, name: config.orchestrator.name });
        if (req.method === 'GET'  && url === '/v1/runs')  return send(200, await store.list());
        if (req.method === 'GET'  && url === '/v1/agents') return send(200, JSON.parse(await hListAgentsJson(ctx)));
        if (req.method === 'GET'  && url === '/v1/config') return send(200, JSON.parse(await hGetConfig(ctx)));

        // ── Config CRUD ───────────────────────────────────────────────────────
        if (req.method === 'GET'    && url === '/v1/config/agents')         return send(200, configStore.listAgents());
        if (req.method === 'POST'   && url === '/v1/config/agents') {
            const body = await readBody() as StoredAgent;
            return send(200, JSON.parse(await hSaveAgent(ctx, body)));
        }
        if (req.method === 'DELETE' && url.startsWith('/v1/config/agents/')) {
            const id = url.slice('/v1/config/agents/'.length);
            return send(200, JSON.parse(await hDeleteAgent(ctx, id)));
        }

        if (req.method === 'GET'    && url === '/v1/config/flows')          return send(200, configStore.listFlows());
        if (req.method === 'POST'   && url === '/v1/config/flows') {
            const body = await readBody() as StoredFlow;
            return send(200, JSON.parse(await hSaveFlow(ctx, body)));
        }
        if (req.method === 'DELETE' && url.startsWith('/v1/config/flows/')) {
            const id = url.slice('/v1/config/flows/'.length);
            return send(200, JSON.parse(await hDeleteFlow(ctx, id)));
        }

        // ── Async start ───────────────────────────────────────────────────────
        if (req.method === 'POST' && url === '/v1/runs/start') {
            try {
                const body   = await readBody() as { flow_id: string; input?: Record<string, unknown> };
                const result = JSON.parse(await hStartFlow(ctx, body.flow_id, body.input ?? {})) as { run_id?: string; error?: string };
                return send(result.error ? 400 : 202, result);
            } catch { return send(400, { error: 'Invalid JSON body' }); }
        }

        // ── Deploy (Docker runtime) ───────────────────────────────────────────

        if (url.startsWith('/v1/deploy')) {
            if (!dockerRuntime) return send(503, { error: 'Docker runtime not available' });

            // GET /v1/deploy — list managed containers
            if (req.method === 'GET' && url === '/v1/deploy') {
                try { return send(200, await dockerRuntime.list()); }
                catch (e) { return send(500, { error: (e as Error).message }); }
            }

            // POST /v1/deploy — deploy a new agent container + register in pool
            if (req.method === 'POST' && url === '/v1/deploy') {
                let spec: DeploySpec;
                try { spec = await readBody() as DeploySpec; }
                catch { return send(400, { error: 'Invalid JSON body' }); }

                if (!spec.id)    return send(400, { error: 'id is required' });
                if (!spec.image) return send(400, { error: 'image is required' });

                try {
                    const { url: agentUrl, instanceId } = await dockerRuntime.deploy(spec);

                    // Persist in ConfigStore + hot-reload pool
                    const stored: StoredAgent = {
                        id:          spec.id,
                        description: spec.description ?? spec.image,
                        transport:   'http',
                        strategy:    spec.strategy ?? 'round-robin',
                        capability:  spec.capability ?? 'execute',
                        gate:        false,
                        timeout:     undefined,
                        instances:   [{ url: agentUrl, ...(spec.apiKey ? { apiKey: spec.apiKey } : {}) }],
                    };
                    configStore.saveAgent(stored);
                    registry.upsertAgent(stored);

                    log(`deployed ${spec.id} → ${agentUrl} (${instanceId})`);
                    return send(201, { ok: true, agentId: spec.id, instanceId, url: agentUrl });
                } catch (e) {
                    return send(500, { error: (e as Error).message });
                }
            }

            // DELETE /v1/deploy/:agentId — stop container + unregister
            if (req.method === 'DELETE' && url.startsWith('/v1/deploy/')) {
                const agentId = decodeURIComponent(url.slice('/v1/deploy/'.length));
                if (!agentId) return send(400, { error: 'agentId is required' });

                try {
                    await dockerRuntime.stopByAgentId(agentId);
                    configStore.deleteAgent(agentId);
                    registry.removeAgent(agentId);

                    log(`undeployed ${agentId}`);
                    return send(200, { ok: true, agentId });
                } catch (e) {
                    return send(500, { error: (e as Error).message });
                }
            }
        }

        // ── Generic tool call ─────────────────────────────────────────────────
        if (req.method === 'POST' && url === '/v1/tools/call') {
            let name: string; let args: Record<string, unknown>;
            try {
                const body = await readBody() as { name: string; arguments?: Record<string, unknown> };
                name = body.name; args = body.arguments ?? {};
            } catch { return send(400, { ok: false, error: 'Invalid JSON body' }); }
            try { return send(200, { ok: true, result: await dispatch(ctx, name, args) }); }
            catch (err) { return send(200, { ok: false, error: (err as Error).message }); }
        }

        send(404, { error: 'Not found' });
    });

    httpServer.listen(port, () => {
        log(`${config.orchestrator.name} HTTP on :${port}`);
        log(`agents: ${registry.agentIds().join(', ')}`);
        log(`flows: ${configStore.listFlows().map(f => f.id).join(', ') || '(none)'}`);
    });

// ── Stdio MCP mode ────────────────────────────────────────────────────────────

} else {
    const ok  = (text: string) => ({ content: [{ type: 'text' as const, text }] });
    const mcp = new McpServer({ name: config.orchestrator.name, version: '0.1.0' });

    mcp.tool('run_flow', 'Trigger a named flow with input data (blocking).', {
        flow_id: z.string(), input: z.record(z.unknown()).default({}),
    }, async ({ flow_id, input }) => {
        try { return ok(await hRunFlow(ctx, flow_id, input)); }
        catch (err) { return ok(`Error: ${(err as Error).message}`); }
    });

    mcp.tool('start_flow', 'Start a named flow asynchronously. Returns run_id immediately.', {
        flow_id: z.string(), input: z.record(z.unknown()).default({}),
    }, async ({ flow_id, input }) => {
        try { return ok(await hStartFlow(ctx, flow_id, input)); }
        catch (err) { return ok(JSON.stringify({ error: (err as Error).message })); }
    });

    mcp.tool('run_task', 'Run a task — auto-routes to a matching flow.', {
        task: z.string(), input: z.record(z.unknown()).default({}),
    }, async ({ task, input }) => {
        try { return ok(await hRunTask(ctx, task, input)); }
        catch (err) { return ok(`Error: ${(err as Error).message}`); }
    });

    mcp.tool('orchestrator_approve', 'Approve a paused gate and resume the flow.', {
        run_id: z.string(), feedback: z.string().optional(),
    }, async ({ run_id, feedback }) => {
        try { return ok(await hApprove(ctx, run_id, feedback)); }
        catch (err) { return ok(`Error: ${(err as Error).message}`); }
    });

    mcp.tool('orchestrator_reject', 'Reject a paused gate and cancel the flow.', {
        run_id: z.string(), reason: z.string().optional(),
    }, async ({ run_id, reason }) => {
        try { return ok(await hReject(ctx, run_id, reason)); }
        catch (err) { return ok(`Error: ${(err as Error).message}`); }
    });

    mcp.tool('orchestrator_retry', 'Retry a flow paused on a required step failure.', {
        run_id: z.string(), feedback: z.string().optional(),
    }, async ({ run_id, feedback }) => {
        try { return ok(await hRetry(ctx, run_id, feedback)); }
        catch (err) { return ok(`Error: ${(err as Error).message}`); }
    });

    mcp.tool('run_status', 'Check the status of a flow run.', { run_id: z.string() }, async ({ run_id }) => {
        try { return ok(await hStatus(ctx, run_id)); }
        catch (err) { return ok(`Error: ${(err as Error).message}`); }
    });

    mcp.tool('list_agents', 'List all registered agents and their health status.', {}, async () => {
        try { return ok(await hListAgents(ctx)); } catch (err) { return ok(`Error: ${(err as Error).message}`); }
    });

    mcp.tool('list_agents_json', 'List agents as JSON.', {}, async () => {
        try { return ok(await hListAgentsJson(ctx)); } catch (err) { return ok(`Error: ${(err as Error).message}`); }
    });

    mcp.tool('list_runs', 'List all flow runs as JSON.', {}, async () => {
        try { return ok(await hListRuns(ctx)); } catch (err) { return ok(`Error: ${(err as Error).message}`); }
    });

    mcp.tool('get_config', 'Return full orchestrator config: agents, flows, settings.', {}, async () => {
        try { return ok(await hGetConfig(ctx)); } catch (err) { return ok(`Error: ${(err as Error).message}`); }
    });

    mcp.tool('save_agent', 'Create or update an agent in the config store.', {
        agent: z.string().describe('JSON-serialized StoredAgent'),
    }, async ({ agent }) => {
        try { return ok(await hSaveAgent(ctx, JSON.parse(agent) as StoredAgent)); }
        catch (err) { return ok(JSON.stringify({ ok: false, error: (err as Error).message })); }
    });

    mcp.tool('delete_agent', 'Delete an agent from the config store.', {
        id: z.string(),
    }, async ({ id }) => {
        try { return ok(await hDeleteAgent(ctx, id)); } catch (err) { return ok(`Error: ${(err as Error).message}`); }
    });

    mcp.tool('save_flow', 'Create or update a flow in the config store.', {
        flow: z.string().describe('JSON-serialized StoredFlow'),
    }, async ({ flow }) => {
        try { return ok(await hSaveFlow(ctx, JSON.parse(flow) as StoredFlow)); }
        catch (err) { return ok(JSON.stringify({ ok: false, error: (err as Error).message })); }
    });

    mcp.tool('delete_flow', 'Delete a flow from the config store.', {
        id: z.string(),
    }, async ({ id }) => {
        try { return ok(await hDeleteFlow(ctx, id)); } catch (err) { return ok(`Error: ${(err as Error).message}`); }
    });

    const transport = new StdioServerTransport();
    await mcp.connect(transport);
    log(`${config.orchestrator.name} started (stdio)`);
    log(`agents: ${registry.agentIds().join(', ')}`);
    log(`flows: ${configStore.listFlows().map(f => f.id).join(', ') || '(none)'}`);
}
