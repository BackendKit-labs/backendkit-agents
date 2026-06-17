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
 *   curate_link      — curate from a git repo URL or HTTP documentation page
 *   search_vault     — semantic search (RAG) across the project vault
 *   read_note        — read a curated note by title or path
 *   vault_status     — show vault location, project info, and index stats
 *   reset_vault      — delete all notes, index, and manifests; start fresh
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
import * as http   from 'node:http';
import * as fs     from 'node:fs/promises';
import * as path   from 'node:path';
import * as os     from 'node:os';
import * as crypto from 'node:crypto';
import { execSync } from 'node:child_process';

import { McpServer }                     from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport }          from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z }                             from 'zod';

import { CodeAnalyzer }        from './analyzer.js';
import { DocumentationCurator } from './documentation-curator.js';
import { KnowledgeEngine }      from './knowledge/engine.js';
import { createProvider, type ProviderName } from './providers/index.js';
import { findAllFiles, loadManifest, saveManifest, hasFileChanged, updateManifestEntry, createManifest } from './checksum.js';
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

interface CurationState {
    activeJobs: number;
    lastCompletedAt?: Date;
}

function createMcpServer(ctx: ProjectContext, engine: KnowledgeEngine, curation: CurationState): McpServer {
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
                    const dir = path.dirname(targetPath);
                    const rel = path.basename(targetPath);
                    const manifest = (await loadManifest(dir)) ?? createManifest(dir, ctx.vaultPath);

                    // SHA256 manifest: skip unchanged files (no LLM call, no duplicates)
                    if (!(await hasFileChanged(targetPath, rel, manifest))) {
                        return { content: [{ type: 'text' as const, text: JSON.stringify({
                            status: 'skipped',
                            message: 'File unchanged since last curation (SHA256 match)',
                            file: rel,
                        }) }] };
                    }

                    curation.activeJobs++;
                    const result = await analyzer.analyzeFile(targetPath, targetPath);
                    const transient = result.errors?.some(e => /LLM call failed|Cannot read file|Cannot extract PDF/i.test(e));
                    if (!transient) {
                        await updateManifestEntry(manifest, targetPath, rel, 'success');
                        await saveManifest(dir, manifest);
                    }
                    engine.reload()
                        .then(() => log('✓ Vault reindexed after single-file curation'))
                        .catch(err => log(`⚠ Auto-reindex failed: ${(err as Error).message}`))
                        .finally(() => { curation.activeJobs--; curation.lastCompletedAt = new Date(); });
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

                // SHA256 manifest: only (re)curate files whose content changed since last run.
                const manifest = (await loadManifest(targetPath)) ?? createManifest(targetPath, ctx.vaultPath);
                const changed: typeof files = [];
                for (const file of files) {
                    if (await hasFileChanged(file.fullPath, file.relativePath, manifest)) {
                        changed.push(file);
                    }
                }

                if (changed.length === 0) {
                    return {
                        content: [{
                            type: 'text' as const,
                            text: JSON.stringify({
                                status: 'completed',
                                message: 'All files unchanged since last curation (SHA256 match) — nothing to do',
                                totalFiles: files.length,
                                changedFiles: 0,
                                skippedFiles: files.length,
                            }),
                        }]
                    };
                }

                const codeCount = changed.filter(f => /\.(ts|tsx|js|jsx|py|go|rs|java|c|cpp|kt|swift)$/.test(f.relativePath)).length;
                const docCount  = changed.filter(f => /\.(md|txt)$/.test(f.relativePath)).length;

                // Process in background without blocking, then auto-reindex
                curation.activeJobs++;
                (async () => {
                    try {
                        const batchSize = 10;
                        for (let i = 0; i < changed.length; i += batchSize) {
                            const batch = changed.slice(i, i + batchSize);
                            await Promise.all(
                                batch.map(async file => {
                                    try {
                                        const res = await analyzer.analyzeFile(file.fullPath, file.relativePath, files);
                                        const transient = res.errors?.some(e => /LLM call failed|Cannot read file|Cannot extract PDF/i.test(e));
                                        if (!transient) {
                                            await updateManifestEntry(manifest, file.fullPath, file.relativePath, 'success');
                                        } else {
                                            log(`✗ ${file.relativePath}: ${res.errors.join('; ')}`);
                                        }
                                    } catch (err) {
                                        log(`✗ ${file.relativePath}: ${(err as Error).message}`);
                                    }
                                })
                            );
                            // Persist manifest progress per batch so a crash/restart resumes correctly.
                            await saveManifest(targetPath, manifest);
                        }
                        log(`✓ Curated ${changed.length} changed files from ${targetPath} (${files.length - changed.length} unchanged)`);
                        await engine.reload();
                        log('✓ Vault reindexed automatically');
                    } catch (err) {
                        log(`⚠ Curation/reindex failed: ${(err as Error).message}`);
                    } finally {
                        curation.activeJobs--;
                        curation.lastCompletedAt = new Date();
                    }
                })();

                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            status: 'processing',
                            message: `Started curation of ${changed.length} changed files in background (${files.length - changed.length} unchanged, skipped)`,
                            totalFiles: files.length,
                            changedFiles: changed.length,
                            skippedFiles: files.length - changed.length,
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

    // ── curate_link ──────────────────────────────────────────────────────────

    t(
        'curate_link',
        'Curate knowledge from an external source into the project vault. ' +
        'Supports git repository URLs (GitHub, GitLab, Bitbucket, or any git remote) ' +
        'and HTTP/HTTPS documentation pages. ' +
        'Git repos are cloned with --depth 1 (no full history) and processed file by file in the background. ' +
        'HTTP/HTTPS pages are fetched, converted to markdown, and analyzed by the LLM directly (synchronous). ' +
        'Use subPath to target a specific subdirectory of a large repository.',
        {
            url: z.string().describe(
                'Git repository URL (e.g. "https://github.com/org/repo") or HTTP/HTTPS URL to a documentation page. ' +
                'Git URLs ending in .git or from known hosts (github.com, gitlab.com, bitbucket.org, codeberg.org) are auto-detected as git.'
            ),
            subPath: z.string().optional().describe(
                'Subdirectory within a git repo to curate instead of the full repo. ' +
                'Example: "src/auth" or "packages/core". Ignored for HTTP URLs.'
            ),
            branch: z.string().optional().describe(
                'Git branch, tag, or commit to clone. Defaults to the remote\'s default branch. Ignored for HTTP URLs.'
            ),
        },
        async ({ url, subPath, branch }: { url: string; subPath?: string; branch?: string }) => {
            try {
                if (isGitUrl(url)) {
                    // ── Git repo: clone + curate in background ────────────────
                    const urlHash = crypto.createHash('md5')
                        .update(url + (branch ?? '') + (subPath ?? ''))
                        .digest('hex').slice(0, 12);
                    const tempDir = path.join(os.tmpdir(), `codex-link-${urlHash}`);

                    curation.activeJobs++;
                    (async () => {
                        try {
                            await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
                            log(`↓ Cloning ${url}${branch ? `@${branch}` : ''}...`);

                            execSync(
                                `git clone --depth 1${branch ? ` --branch "${branch}"` : ''} "${url}" "${tempDir}"`,
                                { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000, encoding: 'utf-8' },
                            );

                            const targetPath = subPath ? path.join(tempDir, subPath) : tempDir;
                            const stat = await fs.stat(targetPath).catch(() => null);
                            if (!stat?.isDirectory()) {
                                throw new Error(`subPath "${subPath}" not found in cloned repository`);
                            }

                            const files = await findAllFiles(targetPath);
                            if (files.length === 0) {
                                log(`⚠ No supported files found in ${targetPath}`);
                                return;
                            }

                            log(`→ Curating ${files.length} files from ${url}...`);
                            const analyzer = new CodeAnalyzer({ provider: makeProvider(), vaultPath: ctx.vaultPath });
                            const batchSize = 10;
                            for (let i = 0; i < files.length; i += batchSize) {
                                const batch = files.slice(i, i + batchSize);
                                await Promise.all(batch.map(async file => {
                                    try {
                                        await analyzer.analyzeFile(file.fullPath, file.relativePath, files);
                                    } catch (err) {
                                        log(`✗ ${file.relativePath}: ${(err as Error).message}`);
                                    }
                                }));
                            }

                            await engine.reload();
                            log(`✓ curate_link complete: ${files.length} files from ${url}`);
                        } catch (err) {
                            log(`✗ curate_link failed (${url}): ${(err as Error).message}`);
                        } finally {
                            await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
                            curation.activeJobs--;
                            curation.lastCompletedAt = new Date();
                        }
                    })();

                    return {
                        content: [{
                            type: 'text' as const,
                            text: JSON.stringify({
                                status: 'processing',
                                source: 'git',
                                url,
                                ...(branch   ? { branch }   : {}),
                                ...(subPath  ? { subPath }  : {}),
                                message: `Cloning and curating ${url} in background. Check vault_status for completion.`,
                                vault: ctx.vaultPath,
                            }),
                        }]
                    };

                } else if (url.startsWith('http://') || url.startsWith('https://')) {
                    // ── HTTP URL: fetch + convert + analyze (synchronous) ─────
                    log(`↓ Fetching ${url}...`);
                    const response = await fetch(url, {
                        headers: { 'User-Agent': 'codex-context-agent/0.2 (knowledge-curator)' },
                        signal: AbortSignal.timeout(30_000),
                    });

                    if (!response.ok) {
                        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                    }

                    const contentType = response.headers.get('content-type') ?? '';
                    let text: string;

                    if (contentType.includes('text/html')) {
                        text = htmlToMarkdown(await response.text());
                    } else if (contentType.includes('text/markdown') || contentType.includes('text/plain')) {
                        text = await response.text();
                    } else {
                        throw new Error(
                            `Unsupported content-type: ${contentType}. ` +
                            'Only text/html, text/markdown, and text/plain are supported. ' +
                            'JavaScript-rendered SPAs are not supported — use a static documentation URL.'
                        );
                    }

                    if (text.trim().length < 100) {
                        throw new Error(
                            'Page content too short after extraction (< 100 chars). ' +
                            'The page may be JavaScript-rendered — try a static documentation URL.'
                        );
                    }

                    // Use the URL itself as source_path so dedup works across re-runs
                    const curator = new DocumentationCurator({ provider: makeProvider(), vaultPath: ctx.vaultPath });
                    const result = await curator.curateText(text, url, undefined, url);

                    engine.reload()
                        .then(() => log('✓ Vault reindexed after curate_link'))
                        .catch(err => log(`⚠ Auto-reindex failed: ${(err as Error).message}`));

                    log(`✓ curate_link complete: ${result.notesWritten.length} notes from ${url}`);
                    return {
                        content: [{
                            type: 'text' as const,
                            text: JSON.stringify({ ...result, source: 'http', url }),
                        }]
                    };

                } else {
                    return {
                        content: [{
                            type: 'text' as const,
                            text: JSON.stringify({
                                error: 'Unsupported URL scheme. Use a git URL (https://github.com/...) or an HTTP/HTTPS documentation URL.',
                            }),
                        }]
                    };
                }
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

                const claudeMdSuggestion = noteCount === 0 ? [
                    '## Vault de conocimiento (codex-context MCP)',
                    '',
                    'Este proyecto tiene un vault activo. Antes de explorar archivos, buscá en el vault:',
                    '',
                    '```',
                    'search_vault("tu pregunta en lenguaje natural")',
                    '```',
                    '',
                    'Flujo recomendado:',
                    '1. `search_vault(...)` — orientación sobre el área de trabajo',
                    '2. `read_note("título")` — detalle completo de una nota',
                    '3. Trabajar en el código',
                    `4. \`curate_path("archivo modificado")\` — actualizar el vault`,
                ].join('\n') : undefined;

                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            project: ctx.projectName,
                            projectRoot: ctx.projectRoot,
                            vaultPath: ctx.vaultPath,
                            noteCount,
                            curating: curation.activeJobs > 0,
                            ...(curation.activeJobs > 0 ? { curatingJobs: curation.activeJobs } : {}),
                            ...(curation.lastCompletedAt ? { lastCuratedAt: curation.lastCompletedAt.toISOString() } : {}),
                            engine: engineStats,
                            ...(reloadResult ? { reindexed: reloadResult } : {}),
                            ...(claudeMdSuggestion ? { claudeMdSuggestion } : {}),
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

    // ── clone_vault ──────────────────────────────────────────────────────────

    t(
        'clone_vault',
        'Copy notes from an existing curated vault into the current project vault. ' +
        'Preserves the source directory structure and merges into the active vault. ' +
        'Files that already exist are skipped by default (set overwrite: true to replace them). ' +
        'Triggers an automatic reindex after copying. ' +
        'Useful for seeding a new project with a shared knowledge base (e.g. an AI/LLM theory vault).',
        {
            sourcePath: z.string().describe(
                'Absolute path to the source vault directory. ' +
                'Supports ~ expansion. Example: "~/.codex-vaults/ia-knowledge"'
            ),
            overwrite: z.boolean().optional().describe('Replace notes that already exist in the target vault (default: false)'),
        },
        async ({ sourcePath, overwrite = false }: { sourcePath: string; overwrite?: boolean }) => {
            try {
                const expandedSource = sourcePath.startsWith('~')
                    ? path.join(os.homedir(), sourcePath.slice(1))
                    : sourcePath;

                const stat = await fs.stat(expandedSource).catch(() => null);
                if (!stat?.isDirectory()) {
                    return {
                        content: [{
                            type: 'text' as const,
                            text: JSON.stringify({ error: `Source vault not found or not a directory: ${expandedSource}` }),
                        }]
                    };
                }

                const { copied, skipped } = await cloneVaultDir(expandedSource, ctx.vaultPath, overwrite);

                // Auto-reindex after clone
                curation.activeJobs++;
                engine.reload()
                    .then(() => log('✓ Vault reindexed after clone'))
                    .catch(err => log(`⚠ Auto-reindex failed: ${(err as Error).message}`))
                    .finally(() => { curation.activeJobs--; curation.lastCompletedAt = new Date(); });

                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            status: 'cloned',
                            sourcePath: expandedSource,
                            targetVault: ctx.vaultPath,
                            copied,
                            skipped,
                            totalNotes: copied + skipped,
                            reindexing: true,
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

    // ── init_embedder ────────────────────────────────────────────────────────

    t(
        'init_embedder',
        'Download and initialize the local embedding model (nomic-embed-text-v1, ~274MB). ' +
        'Run this once after setting up the agent in a new machine or project — it pre-caches the model ' +
        'so the first search_vault or reindex_vault does not block. ' +
        'Shows download progress in the server logs. ' +
        'If the model is already cached, returns immediately.',
        {},
        async () => {
            const start = Date.now();
            const modelId = process.env.CODEX_EMBED_MODEL ?? 'Xenova/nomic-embed-text-v1';

            let downloaded = false;

            const { alreadyCached } = await engine.initEmbedder((info) => {
                if (info.status === 'initiate') {
                    log(`  ↓ ${info.file}`);
                } else if (info.status === 'downloading' && info.file && typeof info.progress === 'number') {
                    const pct = Math.round(info.progress);
                    const bar = '█'.repeat(Math.floor(pct / 5)) + '░'.repeat(20 - Math.floor(pct / 5));
                    log(`  [${bar}] ${pct}% — ${info.file}`);
                    downloaded = true;
                } else if (info.status === 'done' && info.file) {
                    log(`  ✓ ${info.file}`);
                }
            });

            const durationMs = Date.now() - start;
            const status = alreadyCached ? 'already_cached' : downloaded ? 'downloaded' : 'loaded_from_cache';

            log(`✓ Embedder ready (${status}, ${durationMs}ms)`);

            return {
                content: [{
                    type: 'text' as const,
                    text: JSON.stringify({
                        status,
                        model: modelId,
                        cacheDir: `${os.homedir()}/.cache/codex-context/models`,
                        durationMs,
                    }),
                }]
            };
        },
    );

    // ── reindex_vault ─────────────────────────────────────────────────────────

    t(
        'reindex_vault',
        'Rebuild the semantic search index for the current project vault. ' +
        'Waits until the index is complete before returning. ' +
        'Use this after clone_vault or when vault_status shows indexed: false. ' +
        'For automatic reindexing after curate_path, this is not needed — it happens in background.',
        {},
        async () => {
            const start = Date.now();
            log('Reindexing vault...');
            curation.activeJobs++;
            try {
                const result = await engine.reload();
                curation.lastCompletedAt = new Date();
                log(`✓ Vault reindexed: ${result.indexed} notes`);
                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            status: 'indexed',
                            indexed: result.indexed,
                            updated: result.updated,
                            durationMs: Date.now() - start,
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
            } finally {
                curation.activeJobs--;
            }
        },
    );

    // ── reset_vault ──────────────────────────────────────────────────────────

    t(
        'reset_vault',
        'Delete all curated notes, the semantic search index, and all SHA256 curation manifests for the current project vault. ' +
        'Use when the vault is corrupted, outdated, or no longer relevant to the current project version. ' +
        'The vault directory is recreated empty and the in-memory index is reset. ' +
        'After this, run curate_path again to rebuild the vault from scratch.',
        {},
        async () => {
            try {
                // Count notes before deletion for the report
                let noteCount = 0;
                try {
                    const entries = await fs.readdir(ctx.vaultPath, { withFileTypes: true });
                    for (const entry of entries) {
                        if (entry.isDirectory()) {
                            const subEntries = await fs.readdir(path.join(ctx.vaultPath, entry.name)).catch(() => [] as string[]);
                            noteCount += subEntries.filter(f => f.endsWith('.md')).length;
                        } else if (entry.isFile() && entry.name.endsWith('.md')) {
                            noteCount++;
                        }
                    }
                } catch { /* ignore */ }

                // 1. Delete vault contents and recreate empty
                await fs.rm(ctx.vaultPath, { recursive: true, force: true });
                await fs.mkdir(ctx.vaultPath, { recursive: true });

                // 2. Delete RAG index
                const indexPath = path.join(os.homedir(), '.codex-context', 'rag', `${ctx.projectName}.json`);
                let indexDeleted = false;
                try {
                    await fs.rm(indexPath, { force: true });
                    indexDeleted = true;
                } catch { /* ignore */ }

                // 3. Delete all SHA256 manifests under the project root
                const manifestsDeleted = await deleteManifests(ctx.projectRoot);

                // 4. Reset in-memory engine state by reindexing the now-empty vault
                await engine.reload();
                curation.lastCompletedAt = undefined;

                log(`✓ Vault reset: deleted ${noteCount} notes, ${manifestsDeleted} manifests`);

                return {
                    content: [{
                        type: 'text' as const,
                        text: JSON.stringify({
                            status: 'reset',
                            vaultPath: ctx.vaultPath,
                            notesDeleted: noteCount,
                            indexDeleted,
                            manifestsDeleted,
                            message: `Vault reset. Run curate_path("${ctx.projectRoot}") to rebuild from scratch.`,
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

// ── clone_vault helper ────────────────────────────────────────────────────────

async function cloneVaultDir(
    srcDir: string,
    destDir: string,
    overwrite: boolean,
): Promise<{ copied: number; skipped: number }> {
    let copied = 0;
    let skipped = 0;

    await fs.mkdir(destDir, { recursive: true });
    const entries = await fs.readdir(srcDir, { withFileTypes: true });

    for (const entry of entries) {
        const srcPath  = path.join(srcDir,  entry.name);
        const destPath = path.join(destDir, entry.name);

        if (entry.isDirectory()) {
            const sub = await cloneVaultDir(srcPath, destPath, overwrite);
            copied  += sub.copied;
            skipped += sub.skipped;
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
            const exists = await fs.access(destPath).then(() => true).catch(() => false);
            if (exists && !overwrite) {
                skipped++;
            } else {
                await fs.copyFile(srcPath, destPath);
                copied++;
            }
        }
    }

    return { copied, skipped };
}

// ── curate_link helpers ───────────────────────────────────────────────────────

function isGitUrl(url: string): boolean {
    if (url.startsWith('git@') || url.startsWith('git://')) return true;
    if (!url.startsWith('http://') && !url.startsWith('https://')) return false;
    return (
        url.endsWith('.git') ||
        /^https?:\/\/(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)\//i.test(url)
    );
}

function htmlToMarkdown(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[\s\S]*?<\/footer>/gi, '')
        .replace(/<header[\s\S]*?<\/header>/gi, '')
        .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n# $1\n')
        .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n## $1\n')
        .replace(/<h3[^>]*>([\s\S]*?)<\/h3>/gi, '\n### $1\n')
        .replace(/<h4[^>]*>([\s\S]*?)<\/h4>/gi, '\n#### $1\n')
        .replace(/<pre[^>]*><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, '\n```\n$1\n```\n')
        .replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`')
        .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, '\n- $1')
        .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
        .replace(/<strong[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**')
        .replace(/<em[^>]*>([\s\S]*?)<\/em>/gi, '*$1*')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, ' ')
        .replace(/&#x27;/g, "'")
        .replace(/&#x2F;/g, '/')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

// ── deleteManifests helper ────────────────────────────────────────────────────

async function deleteManifests(dir: string): Promise<number> {
    let count = 0;
    let entries: Awaited<ReturnType<typeof fs.readdir>>;
    try {
        entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
        return count;
    }
    for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git' ||
            entry.name === 'dist' || entry.name === 'build' || entry.name.startsWith('.')) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            count += await deleteManifests(fullPath);
        } else if (entry.isFile() && entry.name === '.codex-manifest.json') {
            await fs.rm(fullPath, { force: true });
            count++;
        }
    }
    return count;
}

// ── Transports ────────────────────────────────────────────────────────────────

async function startStdio(ctx: ProjectContext, engine: KnowledgeEngine, curation: CurationState): Promise<void> {
    const srv       = createMcpServer(ctx, engine, curation);
    const transport = new StdioServerTransport();
    await srv.connect(transport);
    log('✓ Stdio transport ready');
}

async function startHttp(port: number, ctx: ProjectContext, engine: KnowledgeEngine, curation: CurationState): Promise<void> {
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
            const srv       = createMcpServer(ctx, engine, curation);
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

    const curation: CurationState = { activeJobs: 0 };

    // Stdio (always active)
    await startStdio(ctx, engine, curation);

    // HTTP (optional)
    if (HTTP_PORT !== null) {
        await startHttp(HTTP_PORT, ctx, engine, curation);
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
