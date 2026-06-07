import http from 'http';
import { loadConfig } from './config';
import { getClient } from './docker/client';
import { containerCreate, containerExec, containerStop, containerRemove, containerLogs, containerInspect } from './tools/container';
import { systemInfo, systemPrune } from './tools/system';
import type { ExecutionContext } from '@backendkit-labs/agent-core';

const ctx: ExecutionContext = {
  agentId: 'docker-agent',
  sessionId: 'server-session',
  memory: { get: () => undefined, set: () => {}, getAll: () => ({}) },
  askAgent: async () => '',
};

const tools: Record<string, (args: unknown) => Promise<string>> = {
  container_create: (args) => containerCreate.execute(args, ctx),
  container_exec: (args) => containerExec.execute(args, ctx),
  container_stop: (args) => containerStop.execute(args, ctx),
  container_remove: (args) => containerRemove.execute(args, ctx),
  container_logs: (args) => containerLogs.execute(args, ctx),
  container_inspect: (args) => containerInspect.execute(args, ctx),
  system_info: (args) => systemInfo.execute(args, ctx),
  system_prune: (args) => systemPrune.execute(args, ctx),
};

function parseBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => body += chunk.toString());
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function sendJSON(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

async function main(): Promise<void> {
  const config = loadConfig();
  const port = parseInt(process.env.AGENT_PORT || '3000', 10);

  try {
    getClient();
    console.log('✅ Docker daemon connected');
  } catch (err) {
    console.error('❌ Docker daemon not available:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      sendJSON(res, 200, { status: 'ok', agent: 'docker-agent' });
      return;
    }

    if (req.method === 'GET' && req.url === '/tools') {
      sendJSON(res, 200, {
        tools: Object.keys(tools).map(name => ({
          name,
          description: tools[name].toString().slice(0, 100),
        })),
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/execute') {
      try {
        const body = await parseBody(req) as { tool: string; params?: Record<string, unknown> };
        const { tool, params = {} } = body;

        if (!tool) {
          sendJSON(res, 400, { status: 'error', error: { code: 'INVALID_PARAMS', message: 'tool is required' } });
          return;
        }

        const executor = tools[tool];
        if (!executor) {
          sendJSON(res, 404, { status: 'error', error: { code: 'TOOL_NOT_FOUND', message: `Tool "${tool}" not found` } });
          return;
        }

        const result = await executor(params);
        sendJSON(res, 200, { status: 'ok', data: JSON.parse(result) });
      } catch (err) {
        const error = err as Error;
        sendJSON(res, 500, {
          status: 'error',
          error: {
            code: (error as unknown as Record<string, unknown>).code || 'INTERNAL_ERROR',
            message: error.message,
          },
        });
      }
      return;
    }

    sendJSON(res, 404, { status: 'error', error: { code: 'NOT_FOUND', message: `Route ${req.method} ${req.url} not found` } });
  });

  server.listen(port, () => {
    console.log(`🐳 Docker Agent server listening on http://localhost:${port}`);
    console.log(`   POST /execute  — ejecutar tool`);
    console.log(`   GET  /tools    — listar tools`);
    console.log(`   GET  /health   — health check`);
  });
}

main().catch(err => {
  console.error('Fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
