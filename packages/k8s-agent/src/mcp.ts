import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { CallbackTransport } from '@backendkit-labs/agent-core';
import { z } from 'zod';
import { createK8sEngine } from './engine';
import { loadConfig } from './config';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySchema = any;

function runWithEngine(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const transport = new CallbackTransport((event) => {
      switch (event.type) {
        case 'token':       output += event.content; break;
        case 'tool_call':   process.stderr.write(`    ⚡ ${event.name}\n`); break;
        case 'tool_result': process.stderr.write(`      → ${event.success ? 'ok' : 'error'}\n`); break;
        case 'error':       reject(new Error(event.message)); break;
        case 'done':        resolve(output.trim() || '(no output)'); break;
      }
    });
    createK8sEngine(transport).run(prompt).catch(reject);
  });
}

function mcpHandler(buildPrompt: (args: Record<string, unknown>) => string) {
  return async (args: Record<string, unknown>) => {
    const start = Date.now();
    const prompt = buildPrompt(args);
    process.stderr.write(`[k8s-agent] ← ${prompt.slice(0, 80)}\n`);
    const result = await runWithEngine(prompt);
    process.stderr.write(`[k8s-agent] → done in ${Date.now() - start}ms\n`);
    return { content: [{ type: 'text' as const, text: result }] };
  };
}

function buildMcpServer(): McpServer {
  const srv = new McpServer({ name: 'k8s-agent', version: '0.1.0' });

  srv.tool(
    'k8s_execute',
    'Execute any Kubernetes operation in natural language — apply manifests, get resources, check pod logs, exec into pods, delete resources.',
    { task: z.string().describe('What to do — describe in natural language') } as AnySchema,
    mcpHandler(({ task }) => String(task)),
  );

  srv.tool(
    'k8s_deploy',
    'Deploy a workload to Kubernetes.',
    {
      name:      z.string().describe('Deployment name'),
      image:     z.string().describe('Container image (e.g. nginx:latest)'),
      namespace: z.string().optional().describe('Kubernetes namespace (default: "default")'),
      replicas:  z.number().optional().describe('Number of replicas'),
      ports:     z.array(z.number()).optional().describe('Container ports to expose'),
      env:       z.array(z.string()).optional().describe('Environment variables (KEY=value)'),
      manifest:  z.string().optional().describe('Raw YAML manifest (overrides other fields)'),
    } as AnySchema,
    mcpHandler((args) => {
      if (args.manifest) return `Apply this Kubernetes manifest:\n${args.manifest}`;
      const parts = [`Deploy "${args.name}" to Kubernetes.`, `Image: ${args.image}`];
      if (args.namespace) parts.push(`Namespace: ${args.namespace}`);
      if (args.replicas)  parts.push(`Replicas: ${args.replicas}`);
      if (args.ports)     parts.push(`Ports: ${(args.ports as number[]).join(', ')}`);
      if (args.env)       parts.push(`Env: ${(args.env as string[]).join(', ')}`);
      return parts.join('\n');
    }),
  );

  srv.tool(
    'k8s_status',
    'Get the status of Kubernetes resources.',
    {
      resource:  z.string().optional().default('pods').describe('Resource type: pods, deployments, services, nodes, etc.'),
      namespace: z.string().optional().describe('Namespace (omit for all namespaces)'),
      selector:  z.string().optional().describe('Label selector (e.g. app=nginx)'),
    } as AnySchema,
    mcpHandler(({ resource, namespace, selector }) => {
      const ns = namespace ? `in namespace "${namespace}"` : 'across all namespaces';
      const sel = selector ? ` with selector "${selector}"` : '';
      return `Get all ${resource}${sel} ${ns} and show their status.`;
    }),
  );

  return srv;
}

async function startHttp(): Promise<void> {
  const config = loadConfig();
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  const parseBody = async (req: IncomingMessage): Promise<unknown> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString('utf-8');
    return raw ? JSON.parse(raw) : undefined;
  };

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.url !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Use POST /mcp' }));
      return;
    }
    try {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (sessionId && sessions.has(sessionId)) {
        const body = req.method === 'POST' ? await parseBody(req) : undefined;
        await sessions.get(sessionId)!.handleRequest(req, res, body);
        return;
      }
      if (req.method !== 'POST') { res.writeHead(400); res.end('Session ID required for GET'); return; }
      const body = await parseBody(req);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
      const srv = buildMcpServer();
      await srv.connect(transport);
      await transport.handleRequest(req, res, body);
      if (transport.sessionId) {
        sessions.set(transport.sessionId, transport);
        transport.onclose = () => sessions.delete(transport.sessionId!);
      }
    } catch (err) {
      if (!res.headersSent) { res.writeHead(500); res.end(String(err)); }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.mcpPort, config.mcpHost, () => {
      process.stderr.write(`[k8s-agent] HTTP MCP server listening on http://${config.mcpHost}:${config.mcpPort}/mcp\n`);
      resolve();
    });
  });
}

async function startStdio(): Promise<void> {
  const transport = new StdioServerTransport();
  await buildMcpServer().connect(transport);
  process.stderr.write('[k8s-agent] Stdio MCP server ready\n');
}

const mode = process.argv[2] === 'http' || process.stdout.isTTY ? 'http' : 'stdio';
if (mode === 'stdio') {
  startStdio().catch(err => { console.error(err); process.exit(1); });
} else {
  startHttp().catch(err => { console.error(err); process.exit(1); });
}
