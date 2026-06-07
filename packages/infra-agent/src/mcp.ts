import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { CallbackTransport } from '@backendkit-labs/agent-core';
import { z } from 'zod';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnySchema = any;
import { createInfraEngine } from './engine';
import { loadConfig } from './config';

// ── Engine runner ────────────────────────────────────────────────────────────

function runWithEngine(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = '';
    const transport = new CallbackTransport((event) => {
      switch (event.type) {
        case 'token':
          output += event.content;
          break;
        case 'block_start':
          if (event.agent_name)
            process.stderr.write(`  ${event.agent_icon ?? '◎'} ${event.agent_name}\n`);
          break;
        case 'tool_call':
          process.stderr.write(`    ⚡ ${event.name}\n`);
          break;
        case 'tool_result':
          process.stderr.write(`      → ${event.success ? 'ok' : 'error'}\n`);
          break;
        case 'system':
          process.stderr.write(`  [${(event as {level?:string}).level ?? 'info'}] ${(event as {text?:string}).text ?? ''}\n`);
          break;
        case 'error':
          process.stderr.write(`  ✗ ${event.message}\n`);
          reject(new Error(event.message));
          break;
        case 'done':
          resolve(output.trim() || '(no output)');
          break;
      }
    });
    const engine = createInfraEngine(transport);
    engine.run(prompt).catch(reject);
  });
}

function mcpHandler(buildPrompt: (args: Record<string, unknown>) => string) {
  return async (args: Record<string, unknown>) => {
    const start = Date.now();
    const prompt = buildPrompt(args);
    process.stderr.write(`[infra-agent] ← ${prompt.slice(0, 80)}\n`);
    const result = await runWithEngine(prompt);
    process.stderr.write(`[infra-agent] → done in ${Date.now() - start}ms\n`);
    return { content: [{ type: 'text' as const, text: result }] };
  };
}

// ── MCP server builder ───────────────────────────────────────────────────────

function buildMcpServer(): McpServer {
  const srv = new McpServer({ name: 'infra-agent', version: '0.2.0' });

  srv.tool(
    'infra_execute',
    'Execute any infrastructure task in natural language. Routes to the right specialist ' +
      '(Docker, Compose, Swarm, Volumes, Containerd, or Kubernetes) automatically.',
    {
      task: z.string().describe('What to do — describe in natural language'),
      platform: z
        .enum(['docker', 'compose', 'swarm', 'volumes', 'containerd', 'kubernetes', 'auto'])
        .optional()
        .describe('Target platform hint. Default: auto-detect from task description.'),
    } as AnySchema,
    mcpHandler(({ task, platform }) =>
      platform && platform !== 'auto' ? `[Platform: ${platform}] ${task}` : String(task),
    ),
  );

  srv.tool(
    'infra_deploy',
    'Deploy a service or application to the infrastructure.',
    {
      service: z.string().describe('Service or application name'),
      image: z.string().optional().describe('Docker image (e.g. nginx:latest)'),
      platform: z.enum(['docker', 'compose', 'swarm', 'kubernetes']).describe('Deployment target'),
      composeFile: z.string().optional().describe('Path to docker-compose.yml (for compose/swarm)'),
      manifest: z.string().optional().describe('Kubernetes YAML manifest (inline or file path)'),
      replicas: z.number().optional().describe('Number of replicas/instances'),
      ports: z.array(z.string()).optional().describe('Port mappings (host:container)'),
      env: z.array(z.string()).optional().describe('Environment variables (KEY=value)'),
    } as AnySchema,
    mcpHandler((args) => {
      const parts = [`Deploy service "${args.service}" on ${args.platform}.`];
      if (args.image) parts.push(`Image: ${args.image}`);
      if (args.replicas) parts.push(`Replicas: ${args.replicas}`);
      if (args.ports) parts.push(`Ports: ${(args.ports as string[]).join(', ')}`);
      if (args.env) parts.push(`Env: ${(args.env as string[]).join(', ')}`);
      if (args.composeFile) parts.push(`Compose file: ${args.composeFile}`);
      if (args.manifest) parts.push(`Manifest:\n${args.manifest}`);
      return parts.join('\n');
    }),
  );

  srv.tool(
    'infra_status',
    'Get the current status of infrastructure services and containers.',
    {
      platform: z
        .enum(['docker', 'compose', 'swarm', 'kubernetes', 'all'])
        .optional()
        .default('all')
        .describe('Which platform to query'),
      composeFile: z.string().optional().describe('Compose file path (required for compose status)'),
      namespace: z.string().optional().describe('Kubernetes namespace'),
    } as AnySchema,
    mcpHandler(({ platform, composeFile, namespace }) => {
      if (platform === 'compose' && composeFile)
        return `Show the status of all services in compose file: ${composeFile}`;
      if (platform === 'kubernetes')
        return `Get Kubernetes pods, deployments and services status in namespace: ${namespace ?? 'default'}`;
      if (platform === 'swarm')
        return 'List all Docker Swarm services and stacks with their replica status';
      if (platform === 'docker')
        return 'List all running Docker containers with their status and resource usage';
      return 'Give me a full infrastructure status report: running Docker containers, Swarm services (if any), and Docker system info.';
    }),
  );

  return srv;
}

// ── Entry points ─────────────────────────────────────────────────────────────

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

      if (req.method !== 'POST') {
        res.writeHead(400); res.end('Session ID required for GET'); return;
      }

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
      process.stderr.write(`[infra-agent] HTTP MCP server listening on http://${config.mcpHost}:${config.mcpPort}/mcp\n`);
      resolve();
    });
  });
}

async function startStdio(): Promise<void> {
  const transport = new StdioServerTransport();
  await buildMcpServer().connect(transport);
  process.stderr.write('[infra-agent] Stdio MCP server ready\n');
}

// Start mode: stdio if no TTY (subprocess), HTTP otherwise
const mode = process.argv[2] === 'http' || process.stdout.isTTY ? 'http' : 'stdio';
if (mode === 'stdio') {
  startStdio().catch(err => { console.error(err); process.exit(1); });
} else {
  startHttp().catch(err => { console.error(err); process.exit(1); });
}
