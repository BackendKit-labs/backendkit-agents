#!/usr/bin/env node
/**
 * curator-codex-agent — Unified MCP Server (Stdio + HTTP)
 *
 * Dual-transport MCP server for maximum flexibility:
 *   - Stdio Transport (always active) — for Claude Desktop, local agents
 *   - HTTP Transport (optional)        — for remote clients
 *
 * Both transports can run simultaneously, allowing:
 *   ✓ Claude Desktop (stdio) + remote clients (HTTP)
 *   ✓ bk-agent embedding (stdio) + external tools (HTTP)
 *
 * Required env vars:
 *   CURATOR_API_KEY      — LLM API key
 *   CURATOR_OUTPUT_PATH  — vault path
 *
 * Optional:
 *   CURATOR_HTTP_PORT    — Enable HTTP transport on this port (e.g., 3101)
 *   CURATOR_MODEL        — LLM model (default: deepseek-reasoner)
 *   CURATOR_BASE_URL     — Custom LLM base URL
 *
 * Usage:
 *   # Stdio only (default, for Claude Desktop)
 *   npm start
 *
 *   # Stdio + HTTP (for maximum flexibility)
 *   CURATOR_HTTP_PORT=3101 npm start
 *
 *   # Stdio + HTTP + verbose logging
 *   DEBUG=* CURATOR_HTTP_PORT=3101 npm start
 */

import 'dotenv/config';
import * as http from 'node:http';
import * as path from 'node:path';
import * as fs   from 'node:fs/promises';

import { McpServer }                     from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport }          from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z }                             from 'zod';
import { CodeAnalyzer }                  from './analyzer.js';
import { KnowledgeEngine }               from './knowledge/engine.js';
import { createProvider }                from './providers/index.js';
import { findAllFiles }                  from './checksum.js';
import { ConfigManager }                 from './api/config.js';

// ── Configuration ────────────────────────────────────────────────────────────

const API_KEY      = process.env.CURATOR_API_KEY ?? '';
const VAULT_PATH   = process.env.CURATOR_OUTPUT_PATH ?? '';
const HTTP_PORT    = process.env.CURATOR_HTTP_PORT ? parseInt(process.env.CURATOR_HTTP_PORT) : null;
const ENABLE_HTTP   = HTTP_PORT !== null;

let knowledgeEngine: KnowledgeEngine;
let configManager: ConfigManager;

if (!API_KEY)    { console.error('[codex] ✗ CURATOR_API_KEY is required'); process.exit(1); }
if (!VAULT_PATH) { console.error('[codex] ✗ CURATOR_OUTPUT_PATH is required'); process.exit(1); }

function log(msg: string): void {
    console.error(`[codex] ${msg}`);
}

function makeAnalyzer(): CodeAnalyzer {
    return new CodeAnalyzer({ provider: createProvider(), vaultPath: VAULT_PATH });
}

// ── MCP Server Factory ───────────────────────────────────────────────────────
//
// Creates a fresh MCP server with all tools registered.
// Called once for stdio, once per HTTP request (stateless).

function createMcpServer(knowledgeEngine: KnowledgeEngine, configManager: ConfigManager): McpServer {
    const srv = new McpServer({ name: 'curator-codex-agent', version: '0.2.0' });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const t = srv.tool.bind(srv) as any;

    // curator_process_file
    t(
        'curator_process_file',
        'Analyze a single code or documentation file and extract knowledge into the vault. ' +
        'Supports: TypeScript, JavaScript, Python, Go, Rust, Java, Markdown, Text. ' +
        'Auto-detects file type and processes accordingly.',
        {
            file_path: z.string().describe('Absolute path to the file (.ts, .js, .py, .md, .txt, etc)'),
            relative_path: z.string().optional().describe('Relative path for vault tracking'),
        },
        async ({ file_path, relative_path }: { file_path: string; relative_path?: string }) => {
            try {
                const analyzer = makeAnalyzer();
                const rel = relative_path || path.basename(file_path);
                const result = await analyzer.analyzeFile(file_path, rel);
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify(result),
                    }]
                };
            } catch (err) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            notesWritten: [],
                            notesSkipped: [],
                            errors: [(err as Error).message],
                            durationMs: 0,
                        }),
                    }]
                };
            }
        },
    );

    // curator_process_directory
    t(
        'curator_process_directory',
        'Recursively analyze all code and documentation files in a directory. ' +
        'Intelligently discovers associated documentation (.md files) and combines them with code analysis. ' +
        'Uses manifest tracking to skip unchanged files on subsequent runs. ' +
        'If directory_path is omitted, uses the inputPath from the active workspace.',
        {
            directory_path: z.string().optional().describe('Absolute path to the directory. If omitted, uses active workspace inputPath.'),
        },
        async ({ directory_path }: { directory_path?: string }) => {
            const start = Date.now();
            const result = {
                notesWritten: [] as string[],
                notesSkipped: [] as string[],
                errors: [] as string[],
                filesAnalyzed: [] as string[],
                totalFiles: 0,
                codeFiles: 0,
                docFiles: 0,
                durationMs: 0,
            };

            try {
                // Use provided path or fall back to workspace inputPath
                const targetPath = directory_path || configManager.getInputPath();
                if (!targetPath) {
                    result.errors.push('No directory path provided and workspace inputPath not configured');
                    result.durationMs = Date.now() - start;
                    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
                }

                const files = await findAllFiles(targetPath);
                if (files.length === 0) {
                    result.errors.push('No code or documentation files found');
                    result.durationMs = Date.now() - start;
                    return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
                }

                result.totalFiles = files.length;
                result.codeFiles = files.filter(f => f.relativePath.match(/\.(ts|tsx|js|jsx|py|go|rs|java|c|cpp|kt|swift)$/)).length;
                result.docFiles = files.filter(f => f.relativePath.match(/\.(md|txt)$/)).length;

                const analyzer = makeAnalyzer();
                // Process files in parallel (batches of 10) for better performance
                const batchSize = 10;
                for (let i = 0; i < files.length; i += batchSize) {
                    const batch = files.slice(i, i + batchSize);
                    const promises = batch.map(file =>
                        analyzer.analyzeFile(file.fullPath, file.relativePath, files).catch(err => ({
                            notesWritten: [],
                            notesSkipped: [],
                            errors: [`${file.relativePath}: ${(err as Error).message}`],
                            filesAnalyzed: [],
                        }))
                    );
                    const results = await Promise.all(promises);
                    results.forEach(analyzed => {
                        result.notesWritten.push(...analyzed.notesWritten);
                        result.notesSkipped.push(...analyzed.notesSkipped);
                        result.errors.push(...analyzed.errors);
                        result.filesAnalyzed.push(...(analyzed.filesAnalyzed || []));
                    });
                }
            } catch (err) {
                result.errors.push(`Failed to read directory: ${(err as Error).message}`);
            }

            result.durationMs = Date.now() - start;
            return { content: [{ type: 'text' as const, text: JSON.stringify(result) }] };
        },
    );

    // curator_vault_status
    t(
        'curator_vault_status',
        'Get information about the vault and indexing status.',
        {},
        async () => {
            try {
                const entries = await fs.readdir(VAULT_PATH, { withFileTypes: true });
                const dirs = entries.filter(e => e.isDirectory()).length;
                const files = entries.filter(e => e.isFile()).length;
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            vaultPath: VAULT_PATH,
                            subdirectories: dirs,
                            rootFiles: files,
                            status: 'ready',
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

    // ── Knowledge Engine Tools ─────────────────────────────────────────────

    // knowledge_search
    t(
        'knowledge_search',
        'Search the vault using semantic search (RAG). Returns relevant notes and optionally generates a synthetic summary.',
        {
            query: z.string().describe('Search query (natural language, e.g., "How to handle errors?")'),
            topK: z.number().optional().describe('Number of results to return (default: 5)'),
            autoSynthesize: z.boolean().optional().describe('Generate synthesis note (default: true)'),
        },
        async ({ query, topK, autoSynthesize }: any) => {
            try {
                const response = await knowledgeEngine.search(query, {
                    topK,
                    autoSynthesize: autoSynthesize !== false,
                });
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify(response),
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

    // knowledge_reload
    t(
        'knowledge_reload',
        'Reload and reindex the vault. Call this after external changes to the vault files.',
        {},
        async () => {
            try {
                const response = await knowledgeEngine.reload();
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify(response),
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

    // knowledge_stats
    t(
        'knowledge_stats',
        'Get knowledge engine statistics and status.',
        {},
        async () => {
            try {
                const stats = await knowledgeEngine.getStats();
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify(stats),
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

    // ── Workspace Management ───────────────────────────────────────────────────

    // curator_workspace_list
    t(
        'curator_workspace_list',
        'List all available workspaces and show which one is currently active.',
        {},
        async () => {
            try {
                const bkAgentDir = process.env.BK_AGENT_DIR ||
                    path.join(process.env.HOME || process.env.USERPROFILE || '', '.bk-agent');
                const wsPath = path.join(bkAgentDir, 'curator-workspace.json');

                const content = await fs.readFile(wsPath, 'utf-8');
                const wsConfig = JSON.parse(content);

                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            current: wsConfig.lastUsed,
                            workspaces: wsConfig.workspaces.map((w: any) => ({
                                name: w.name,
                                inputPath: w.inputPath,
                                outputPath: w.outputPath,
                                description: w.description,
                                active: w.name === wsConfig.lastUsed,
                            })),
                        }),
                    }]
                };
            } catch (err) {
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({ error: `Failed to read workspaces: ${(err as Error).message}` }),
                    }]
                };
            }
        },
    );

    // curator_workspace_current
    t(
        'curator_workspace_current',
        'Get details of the currently active workspace.',
        {},
        async () => {
            try {
                const bkAgentDir = process.env.BK_AGENT_DIR ||
                    path.join(process.env.HOME || process.env.USERPROFILE || '', '.bk-agent');
                const wsPath = path.join(bkAgentDir, 'curator-workspace.json');

                const content = await fs.readFile(wsPath, 'utf-8');
                const wsConfig = JSON.parse(content);
                const current = wsConfig.workspaces.find((w: any) => w.name === wsConfig.lastUsed);

                if (!current) {
                    return {
                        content: [{
                            type: 'text' as const,
                            text: JSON.stringify({ error: 'No workspace selected' }),
                        }]
                    };
                }

                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            name: current.name,
                            workspace: current,
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

    // curator_workspace_switch
    t(
        'curator_workspace_switch',
        'Switch to a different workspace. Updates the active workspace globally.',
        {
            name: z.string().describe('Workspace name to switch to'),
        },
        async ({ name }: { name: string }) => {
            try {
                const bkAgentDir = process.env.BK_AGENT_DIR ||
                    path.join(process.env.HOME || process.env.USERPROFILE || '', '.bk-agent');
                const wsPath = path.join(bkAgentDir, 'curator-workspace.json');

                const content = await fs.readFile(wsPath, 'utf-8');
                const wsConfig = JSON.parse(content);
                const workspace = wsConfig.workspaces.find((w: any) => w.name === name);

                if (!workspace) {
                    return {
                        content: [{
                            type: 'text' as const,
                            text: JSON.stringify({
                                success: false,
                                error: `Workspace "${name}" not found`,
                                available: wsConfig.workspaces.map((w: any) => w.name),
                            }),
                        }]
                    };
                }

                wsConfig.lastUsed = name;
                await fs.writeFile(wsPath, JSON.stringify(wsConfig, null, 2), 'utf-8');

                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            success: true,
                            workspace: name,
                            config: {
                                inputPath: workspace.inputPath,
                                outputPath: workspace.outputPath,
                                description: workspace.description,
                            },
                            message: `Switched to workspace: ${name}`,
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

    // curator_workspace_add
    t(
        'curator_workspace_add',
        'Add a new workspace or update an existing one.',
        {
            name: z.string().describe('Workspace name (unique identifier)'),
            inputPath: z.string().describe('Input directory path for curation'),
            outputPath: z.string().describe('Output vault path'),
            description: z.string().optional().describe('Human-readable description'),
        },
        async ({ name, inputPath, outputPath, description }: any) => {
            try {
                const bkAgentDir = process.env.BK_AGENT_DIR ||
                    path.join(process.env.HOME || process.env.USERPROFILE || '', '.bk-agent');
                const wsPath = path.join(bkAgentDir, 'curator-workspace.json');

                const content = await fs.readFile(wsPath, 'utf-8');
                const wsConfig = JSON.parse(content);
                const idx = wsConfig.workspaces.findIndex((w: any) => w.name === name);

                if (idx >= 0) {
                    wsConfig.workspaces[idx] = { name, inputPath, outputPath, description };
                } else {
                    wsConfig.workspaces.push({ name, inputPath, outputPath, description });
                }

                await fs.writeFile(wsPath, JSON.stringify(wsConfig, null, 2), 'utf-8');

                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            success: true,
                            action: idx >= 0 ? 'updated' : 'created',
                            workspace: { name, inputPath, outputPath, description },
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

    // curator_workspace_remove
    t(
        'curator_workspace_remove',
        'Remove a workspace from the configuration.',
        {
            name: z.string().describe('Workspace name to remove'),
        },
        async ({ name }: { name: string }) => {
            try {
                const bkAgentDir = process.env.BK_AGENT_DIR ||
                    path.join(process.env.HOME || process.env.USERPROFILE || '', '.bk-agent');
                const wsPath = path.join(bkAgentDir, 'curator-workspace.json');

                const content = await fs.readFile(wsPath, 'utf-8');
                const wsConfig = JSON.parse(content);
                const idx = wsConfig.workspaces.findIndex((w: any) => w.name === name);

                if (idx < 0) {
                    return {
                        content: [{
                            type: 'text' as const,
                            text: JSON.stringify({
                                success: false,
                                error: `Workspace "${name}" not found`,
                            }),
                        }]
                    };
                }

                wsConfig.workspaces.splice(idx, 1);
                if (wsConfig.lastUsed === name) {
                    wsConfig.lastUsed = wsConfig.workspaces[0]?.name || '';
                }

                await fs.writeFile(wsPath, JSON.stringify(wsConfig, null, 2), 'utf-8');

                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            success: true,
                            removed: name,
                            remaining: wsConfig.workspaces.map((w: any) => w.name),
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

// ── Stdio Transport ──────────────────────────────────────────────────────────

async function startStdio(cfg: ConfigManager): Promise<void> {
    const srv       = createMcpServer(knowledgeEngine, cfg);
    const transport = new StdioServerTransport();
    await srv.connect(transport);
    log('✓ Stdio MCP transport ready');
}

// ── HTTP Transport ──────────────────────────────────────────────────────────

async function startHttp(port: number, cfg: ConfigManager): Promise<void> {
    const server = http.createServer(async (req, res) => {
        if (req.method !== 'POST' || req.url !== '/mcp') {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                error: 'Use POST /mcp',
                message: 'This is an MCP server. POST JSON-RPC requests to /mcp',
            }));
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
            const srv       = createMcpServer(knowledgeEngine, cfg);
            const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
            await srv.connect(transport);
            await transport.handleRequest(req, res, body);
        } catch (err) {
            res.writeHead(500).end(JSON.stringify({
                error: (err as Error).message,
            }));
        }
    });

    await new Promise<void>(resolve => {
        server.listen(port, () => {
            log(`✓ HTTP MCP transport on http://localhost:${port}/mcp`);
            resolve();
        });
    });
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    console.error('');
    log('╔════════════════════════════════════════╗');
    log('║  Curator-Codex Agent — MCP Server      ║');
    log('╚════════════════════════════════════════╝');
    log(`Vault:     ${VAULT_PATH}`);
    log(`Model:     ${process.env.CURATOR_MODEL || 'deepseek-reasoner'}`);

    // Initialize Configuration Manager
    try {
        configManager = new ConfigManager();
    } catch (err) {
        log(`⚠ ConfigManager initialization failed: ${(err as Error).message}`);
        configManager = new ConfigManager({ outputPath: VAULT_PATH });
    }

    // Initialize Knowledge Engine
    try {
        log('Initializing knowledge engine...');
        knowledgeEngine = new KnowledgeEngine(createProvider(), VAULT_PATH);
        await knowledgeEngine.initialize();
        log('✓ Knowledge engine ready');
    } catch (err) {
        log(`⚠ Knowledge engine initialization failed: ${(err as Error).message}`);
        log('  (Curation will work, RAG search will be unavailable)');
        // Don't exit, allow curation-only mode
        knowledgeEngine = new KnowledgeEngine(createProvider(), VAULT_PATH);
    }

    // Start Stdio (always)
    try {
        await startStdio(configManager);
    } catch (err) {
        log(`✗ Stdio transport failed: ${(err as Error).message}`);
        process.exit(1);
    }

    // Start HTTP (optional)
    if (ENABLE_HTTP) {
        try {
            await startHttp(HTTP_PORT!, configManager);
        } catch (err) {
            log(`✗ HTTP transport failed: ${(err as Error).message}`);
            process.exit(1);
        }
    } else {
        log('(HTTP transport disabled. Set CURATOR_HTTP_PORT to enable)');
    }

    console.error('');
    log('Ready for connections');
    console.error('');
}

main().catch(err => {
    log(`✗ Fatal: ${(err as Error).message}`);
    process.exit(1);
});
