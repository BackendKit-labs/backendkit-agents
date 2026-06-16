#!/usr/bin/env node
/**
 * codex-context-agent — MCP Server (Stdio + optional HTTP)
 *
 * Per-project knowledge vault for AI coding agents.
 * Auto-detects the project from git root and creates a vault at
 * ~/.codex-vaults/{project-name}/ — zero manual configuration required.
 *
 * Tools:
 *   curate_path      — analyze a file or directory and store knowledge in the vault
 *   search_vault     — semantic search (RAG) across the project vault
 *   read_note        — read a curated note by title or path
 *   vault_status     — show vault location, project info, and index stats
 *
 * Required env:
 *   CODEX_API_KEY    — LLM API key
 *
 * Optional env:
 *   CODEX_PROJECT_PATH — project root (default: CWD)
 *   CODEX_PROVIDER     — llm provider: deepseek | openai | anthropic | ollama (default: deepseek)
 *   CODEX_MODEL        — model id (default: provider default)
 *   CODEX_BASE_URL     — custom LLM endpoint
 *   CODEX_HTTP_PORT    — enable HTTP transport on this port
 */

import 'dotenv/config';
import * as http from 'node:http';
import * as fs   from 'node:fs/promises';

import { McpServer }                     from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport }          from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z }                             from 'zod';

import { CodeAnalyzer }   from './analyzer.js';
import { KnowledgeEngine } from './knowledge/engine.js';
import { createProvider, type ProviderName } from './providers/index.js';
import { findAllFiles }   from './checksum.js';
import { resolveProject, findNote } from './project.js';
import type { ProjectContext } from './project.js';

// ── Config ───────────────────────────────────────────────────────────────────

const API_KEY   = process.env.CODEX_API_KEY ?? '';
const HTTP_PORT = process.env.CODEX_HTTP_PORT ? parseInt(process.env.CODEX_HTTP_PORT) : null;

if (!API_KEY) {
    console.error('[codex-context] ✗ CODEX_API_KEY is required');
    process.exit(1);
}

function log(msg: string): void {
    console.error(`[codex-context] ${msg}`);
}

function makeProvider() {
    return createProvider({
        provider: (process.env.CODEX_PROVIDER || 'deepseek') as ProviderName,
        apiKey:   API_KEY,
        model:    process.env.CODEX_MODEL,
        baseUrl:  process.env.CODEX_BASE_URL,
    });
}

// ── MCP Server ────────────────────────────────────────────────────────────────

function createMcpServer(ctx: ProjectContext, engine: KnowledgeEngine): McpServer {
    const srv = new McpServer({ name: 'codex-context-agent', version: '0.1.0' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = srv.tool.bind(srv) as any;

    // ── curate_path ──────────────────────────────────────────────────────────

    t(
        'curate_path',
        'Analyze a file or directory and extract structured knowledge into the project vault. ' +
        'Supports code (TypeScript, JavaScript, Python, Go, Rust, Java, C/C++, Kotlin, Swift) ' +
        'and documentation (.md, .txt). ' +
        'For directories, processes all files recursively in the background and returns immediately. ' +
        'Uses SHA256 manifest to skip files that have not changed since last run.',
        {
            path: z.string().describe(
                'Absolute path to a file or directory to curate. ' +
                'Example: "/home/user/project/src/auth.ts" or "/home/user/project/src"'
            ),
        },
        async ({ path: targetPath }: { path: string }) => {
            try {
                const stat = await fs.stat(targetPath);
                const analyzer = new CodeAnalyzer({ provider: makeProvider(), vaultPath: ctx.vaultPath });

                if (stat.isFile()) {
                    const result = await analyzer.analyzeFile(targetPath, targetPath);
                    engine.reload()
                        .then(() => log('✓ Vault reindexed after single-file curation'))
                        .catch(err => log(`⚠ Auto-reindex failed: ${(err as Error).message}`));
                    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
                }

                // Directory — discover files and process in background
                const files = await findAllFiles(targetPath);
                if (files.length === 0) {
                    return {
                        content: [{
                            type: 'text' as const,
                            text: JSON.stringify({ status: 'completed', message: 'No code or documentation files found', totalFiles: 0 }),
                        }]
                    };
                }

                const codeCount = files.filter(f => /\.(ts|tsx|js|jsx|py|go|rs|java|c|cpp|kt|swift)$/.test(f.relativePath)).length;
                const docCount  = files.filter(f => /\.(md|txt)$/.test(f.relativePath)).length;

                // Process in background without blocking, then auto-reindex
                (async () => {
                    const batchSize = 10;
                    for (let i = 0; i < files.length; i += batchSize) {
                        const batch = files.slice(i, i + batchSize);
                        await Promise.all(
                            batch.map(file =>
                                analyzer.analyzeFile(file.fullPath, file.relativePath, files)
                                    .catch(err => log(`✗ ${file.relativePath}: ${(err as Error).message}`))
                            )
                        );
                    }
                    log(`✓ Curated ${files.length} files from ${targetPath}`);
                    try {
                        await engine.reload();
                        log('✓ Vault reindexed automatically');
                    } catch (err) {
                        log(`⚠ Auto-reindex failed: ${(err as Error).message}`);
                    }
                })();

                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            status: 'processing',
                            message: `Started curation of ${files.length} files in background`,
                            totalFiles: files.length,
                            codeFiles: codeCount,
                            docFiles: docCount,
                            vault: ctx.vaultPath,
                        }),
                    }]
                };
            } catch (err) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({ error: (err as Error).message }),
                    }]
                };
            }
        },
    );

    // ── search_vault ─────────────────────────────────────────────────────────

    t(
        'search_vault',
        'Semantic search (RAG) across the project vault. ' +
        'Returns the most relevant curated notes for your query. ' +
        'Optionally generates a synthetic summary note combining insights from the top results. ' +
        'Use this to answer questions about the codebase: architecture decisions, API usage, patterns, etc.',
        {
            query:         z.string().describe('Natural language query, e.g. "How does authentication work?" or "JWT token refresh flow"'),
            topK:          z.number().optional().describe('Number of results to return (default: 5)'),
            autoSynthesize: z.boolean().optional().describe('Generate a synthesis note combining top results (default: true)'),
        },
        async ({ query, topK, autoSynthesize }: { query: string; topK?: number; autoSynthesize?: boolean }) => {
            try {
                const response = await engine.search(query, {
                    topK,
                    autoSynthesize: autoSynthesize !== false,
                });
                return { content: [{ type: 'text' as const, text: JSON.stringify(response) }] };
            } catch (err) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({ error: (err as Error).message }),
                    }]
                };
            }
        },
    );

    // ── read_note ────────────────────────────────────────────────────────────

    t(
        'read_note',
        'Read a specific curated note from the project vault. ' +
        'Accepts a note title (fuzzy match by filename) or a relative/absolute path to a .md file. ' +
        'Use search_vault first to discover note titles, then read_note to get the full content.',
        {
            path_or_title: z.string().describe(
                'Note title (e.g. "AuthService JWT") or relative path within the vault (e.g. "backend/2026-06-16-auth-service.md")'
            ),
        },
        async ({ path_or_title }: { path_or_title: string }) => {
            try {
                const content = await findNote(ctx.vaultPath, path_or_title);
                return { content: [{ type: 'text' as const, text: content }] };
            } catch (err) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({ error: (err as Error).message }),
                    }]
                };
            }
        },
    );

    // ── vault_status ─────────────────────────────────────────────────────────

    t(
        'vault_status',
        'Show the current project context and vault status: project name, root directory, vault path, ' +
        'number of curated notes, and RAG index state. ' +
        'Also call vault_status after curate_path completes to trigger vault reindexing.',
        {
            reload: z.boolean().optional().describe('Reindex the vault after new files were curated (default: false)'),
        },
        async ({ reload }: { reload?: boolean }) => {
            try {
                let reloadResult = undefined;
                if (reload) {
                    reloadResult = await engine.reload();
                }

                const engineStats = await engine.getStats();

                // Count notes in vault
                let noteCount = 0;
                try {
                    const entries = await fs.readdir(ctx.vaultPath, { withFileTypes: true });
                    for (const entry of entries) {
                        if (entry.isDirectory()) {
                            const subPath = `${ctx.vaultPath}/${entry.name}`;
                            const subEntries = await fs.readdir(subPath).catch(() => [] as string[]);
                            noteCount += subEntries.filter(f => f.endsWith('.md')).length;
                        } else if (entry.isFile() && entry.name.endsWith('.md')) {
                            noteCount++;
                        }
                    }
                } catch { /* ignore */ }

                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            project: ctx.projectName,
                            projectRoot: ctx.projectRoot,
                            vaultPath: ctx.vaultPath,
                            noteCount,
                            engine: engineStats,
                            ...(reloadResult ? { reindexed: reloadResult } : {}),
                        }),
                    }]
                };
            } catch (err) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({ error: (err as Error).message }),
                    }]
                };
            }
        },
    );

    return srv;
}

// ── Transports ────────────────────────────────────────────────────────────────

async function startStdio(ctx: ProjectContext, engine: KnowledgeEngine): Promise<void> {
    const srv       = createMcpServer(ctx, engine);
    const transport = new StdioServerTransport();
    await srv.connect(transport);
    log('✓ Stdio transport ready');
}

async function startHttp(port: number, ctx: ProjectContext, engine: KnowledgeEngine): Promise<void> {
    const server = http.createServer(async (req, res) => {
        if (req.method !== 'POST' || req.url !== '/mcp') {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Use POST /mcp' }));
            return;
        }

        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);

        let body: unknown;
        try {
            body = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
            res.writeHead(400).end(JSON.stringify({ error: 'Invalid JSON' }));
            return;
        }

        try {
            const srv       = createMcpServer(ctx, engine);
            const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
            await srv.connect(transport);
            await transport.handleRequest(req, res, body);
        } catch (err) {
            res.writeHead(500).end(JSON.stringify({ error: (err as Error).message }));
        }
    });

    await new Promise<void>(resolve => {
        server.listen(port, () => {
            log(`✓ HTTP transport on http://localhost:${port}/mcp`);
            resolve();
        });
    });
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.error('');
    log('╔═══════════════════════════════════════╗');
    log('║  Codex Context Agent — MCP Server     ║');
    log('╚═══════════════════════════════════════╝');

    // Resolve project (auto-detect git root → vault path)
    const ctx = await resolveProject();
    log(`Project:  ${ctx.projectName}`);
    log(`Root:     ${ctx.projectRoot}`);
    log(`Vault:    ${ctx.vaultPath}`);
    log(`Provider: ${process.env.CODEX_PROVIDER || 'deepseek'} / ${process.env.CODEX_MODEL || 'default model'}`);

    // Initialize knowledge engine — index in background so startup is not blocked
    const engine = new KnowledgeEngine(makeProvider(), ctx.vaultPath);
    engine.initialize()
        .then(() => log('✓ Vault indexed'))
        .catch(err => log(`⚠ Vault indexing skipped: ${(err as Error).message}`));

    // Stdio (always active)
    await startStdio(ctx, engine);

    // HTTP (optional)
    if (HTTP_PORT !== null) {
        await startHttp(HTTP_PORT, ctx, engine);
    } else {
        log('(HTTP disabled — set CODEX_HTTP_PORT to enable)');
    }

    console.error('');
    log('Ready');
    console.error('');
}

main().catch(err => {
    log(`✗ Fatal: ${(err as Error).message}`);
    process.exit(1);
});
