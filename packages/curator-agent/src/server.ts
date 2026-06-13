#!/usr/bin/env node
/**
 * curator-agent — MCP server
 *
 * Transports:
 *   stdio (default)       — Claude Desktop, local agents via child_process
 *   HTTP  (CURATOR_PORT)  — vault-manager, knowledge-agent, remote agents
 *
 * Required env vars:
 *   CURATOR_API_KEY    — provider API key
 *   CURATOR_VAULT_PATH — absolute path to the vault
 *
 * Optional:
 *   CURATOR_PORT         — HTTP port (e.g. 3100). If set, serves HTTP MCP.
 *   CURATOR_MODEL        — orchestration model (default: deepseek-chat)
 *   CURATOR_RESEARCH_MODEL — article generation model (default: deepseek-chat)
 *   CURATOR_BASE_URL     — custom LLM base URL
 *   VAULT_MANAGER_URL    — vault-manager base URL for auto-sync
 *   VAULT_MANAGER_ID     — vault definition ID in vault-manager DB
 *
 * Claude Desktop config:
 *   {
 *     "mcpServers": {
 *       "curator": {
 *         "command": "npx",
 *         "args": ["-y", "@backendkit-labs/curator-agent"],
 *         "env": {
 *           "CURATOR_API_KEY":    "sk-...",
 *           "CURATOR_VAULT_PATH": "/path/to/vault"
 *         }
 *       }
 *     }
 *   }
 */

import * as http from 'node:http';
import * as path from 'node:path';
import * as fs   from 'node:fs/promises';

import { McpServer }                        from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport }             from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport }    from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z }                                from 'zod';
import { CuratorAgent }                     from './agent.js';
import type { ProcessResult }               from './agent.js';

// ── Config ────────────────────────────────────────────────────────────────────

const API_KEY        = process.env.CURATOR_API_KEY ?? '';
const VAULT_PATH     = process.env.CURATOR_VAULT_PATH ?? '';
const MODEL          = process.env.CURATOR_MODEL ?? 'deepseek-chat';
const RESEARCH_MODEL = process.env.CURATOR_RESEARCH_MODEL ?? 'deepseek-chat';
const BASE_URL       = process.env.CURATOR_BASE_URL;
const VM_URL         = process.env.VAULT_MANAGER_URL;
const VM_ID          = process.env.VAULT_MANAGER_ID;
const PORT           = process.env.CURATOR_PORT ? parseInt(process.env.CURATOR_PORT) : null;

if (!API_KEY)    { process.stderr.write('[curator] CURATOR_API_KEY is required\n'); process.exit(1); }
if (!VAULT_PATH) { process.stderr.write('[curator] CURATOR_VAULT_PATH is required\n'); process.exit(1); }

// ── Agent singleton ───────────────────────────────────────────────────────────

let agent: CuratorAgent | null = null;

async function getAgent(): Promise<CuratorAgent> {
    if (agent) return agent;
    agent = new CuratorAgent({
        apiKey:          API_KEY,
        vaultPath:       VAULT_PATH,
        model:           MODEL,
        researchModel:   RESEARCH_MODEL,
        baseUrl:         BASE_URL,
        vaultManagerUrl: VM_URL,
        vaultManagerId:  VM_ID,
        onProgress:      (msg) => process.stderr.write(msg + '\n'),
    });
    await agent.setup();
    return agent;
}

// ── Tool registration ─────────────────────────────────────────────────────────
// Factory: creates a fresh McpServer with all tools wired to the agent singleton.
// Called once for stdio, once per HTTP request (stateless transport).

function createMcpServer(): McpServer {
    const srv = new McpServer({ name: 'curator-agent', version: '0.3.0' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = srv.tool.bind(srv) as any;

    // curator_process
    t(
        'curator_process',
        'Curate a document into the vault. ' +
        'Checks duplicates, normalises tags, and writes a structured .md with frontmatter. ' +
        'Returns JSON: { written, skipped, errors, durationMs }.',
        {
            text: z.string().min(50).describe('Full text of the document (plain text or markdown)'),
            source: z.string().describe('Document origin: filename, URL, email subject, etc.'),
            area_hint: z.string().optional().describe(
                'Area hint: general | insights | operaciones | rrhh | finanzas | legal | calidad',
            ),
        },
        async ({ text, source, area_hint }: { text: string; source: string; area_hint?: string }) => {
            const a = await getAgent();
            const result = await a.process(text, source, area_hint);
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        },
    );

    // curator_process_file
    t(
        'curator_process_file',
        'Read a file from disk and curate it into the vault. Supports .txt, .md, and plain-text formats.',
        {
            file_path: z.string().describe('Absolute path to the file'),
            area_hint: z.string().optional().describe('Area hint for the classifier'),
        },
        async ({ file_path, area_hint }: { file_path: string; area_hint?: string }) => {
            let text: string;
            try {
                text = await fs.readFile(file_path, 'utf-8');
            } catch (err) {
                const result: ProcessResult = { written: [], skipped: [], enriched: [], errors: [(err as Error).message], durationMs: 0 };
                return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
            }
            const a = await getAgent();
            const result = await a.process(text, path.basename(file_path), area_hint);
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        },
    );

    // curator_research
    t(
        'curator_research',
        'Generate a comprehensive markdown article on a topic with LLM and save it to the vault. ' +
        'Checks for duplicate knowledge before writing. ' +
        'Returns JSON: { written, skipped, errors, durationMs }.',
        {
            topic: z.string().describe('Topic to research. Be specific for better results.'),
        },
        async ({ topic }: { topic: string }) => {
            const a = await getAgent();
            const result = await a.research(topic);
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        },
    );

    // curator_research_url
    t(
        'curator_research_url',
        'Capture a URL via Jina Reader (r.jina.ai) as clean markdown and curate it into the vault. ' +
        'No API key required. Works with articles, docs, blog posts, GitHub READMEs. ' +
        'Returns JSON: { written, skipped, errors, durationMs }.',
        {
            url: z.string().url().describe('URL to capture and curate'),
        },
        async ({ url }: { url: string }) => {
            const a = await getAgent();
            const result = await a.researchUrl(url);
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        },
    );

    // curator_vault_status
    t(
        'curator_vault_status',
        'Returns a summary of the vault: total notes, areas, and top tags.',
        {},
        async () => {
            const a = await getAgent();
            return { content: [{ type: 'text' as const, text: a.getMemory().summary() }] };
        },
    );

    // curator_reload
    t(
        'curator_reload',
        'Reload the vault memory index from disk. Call after external changes to the vault.',
        {},
        async () => {
            const a = await getAgent();
            await a.reloadMemory();
            return { content: [{ type: 'text' as const, text: `Reloaded. ${a.getMemory().summary()}` }] };
        },
    );

    return srv;
}

// ── HTTP transport ────────────────────────────────────────────────────────────

async function startHttp(port: number): Promise<void> {
    const server = http.createServer(async (req, res) => {
        if (req.method !== 'POST' || req.url !== '/mcp') {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Use POST /mcp' }));
            return;
        }

        // Read body
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        let body: unknown;
        try {
            body = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
            res.writeHead(400).end('Invalid JSON');
            return;
        }

        // Each request gets a fresh McpServer — CuratorAgent is the shared singleton
        const srv       = createMcpServer();
        const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
        await srv.connect(transport);
        await transport.handleRequest(req, res, body);
    });

    await new Promise<void>(resolve => server.listen(port, resolve));
    process.stderr.write(`[curator] HTTP MCP server on :${port}/mcp\n`);
}

// ── Stdio transport ───────────────────────────────────────────────────────────

async function startStdio(): Promise<void> {
    const srv       = createMcpServer();
    const transport = new StdioServerTransport();
    await srv.connect(transport);
    process.stderr.write('[curator] stdio MCP server ready\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    await getAgent(); // pre-warm — loads VaultMemory before first request

    if (PORT) {
        await startHttp(PORT);
    } else {
        await startStdio();
    }
}

main().catch(err => {
    process.stderr.write(`[curator] Fatal: ${(err as Error).message}\n`);
    process.exit(1);
});
