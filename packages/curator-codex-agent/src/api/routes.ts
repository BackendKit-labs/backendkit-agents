/**
 * HTTP API Routes for Curator-Codex
 * Handles curation and knowledge management endpoints
 */

import { Router, Request, Response } from 'express';
import * as fsp    from 'node:fs/promises';
import * as os     from 'node:os';
import * as path   from 'node:path';
import * as crypto from 'node:crypto';
import { CodeAnalyzer } from '../analyzer.js';
import { KnowledgeEngine } from '../knowledge/engine.js';
import { createProvider } from '../providers/index.js';
import { findAllFiles, isCodeFile, isDocFile } from '../checksum.js';
import type { ConfigManager } from './config.js';
import {
    validateBody,
    CuratorConfigSchema,
    CuratorProcessSchema,
    KnowledgeSearchSchema,
    KnowledgeSearchWithVaultSchema,
    KnowledgeReindexSchema,
    CuratorFileSchema,
    type AuthenticatedRequest,
} from './security.js';

// Module-level cache: one KnowledgeEngine per vault path, persists for process lifetime
const engineCache = new Map<string, KnowledgeEngine>();

async function getEngine(vaultPath: string): Promise<KnowledgeEngine> {
    if (!engineCache.has(vaultPath)) {
        const engine = new KnowledgeEngine(createProvider(), vaultPath);
        await engine.initialize();
        engineCache.set(vaultPath, engine);
    }
    return engineCache.get(vaultPath)!;
}

export function createRoutes(configManager: ConfigManager): Router {
    const router = Router();

    // ── Curator Endpoints ────────────────────────────────────────────────────

    /**
     * POST /curator/config
     * Set curator input and output paths
     */
    router.post(
        '/curator/config',
        validateBody(CuratorConfigSchema),
        (req: AuthenticatedRequest, res: Response) => {
            try {
                const { inputPath, outputPath } = (req as any).validatedBody;

                configManager.setInputPath(inputPath);
                configManager.setOutputPath(outputPath);

                const config = configManager.getConfig();
                res.status(200).json({
                    success: true,
                    config: {
                        inputPath: config.inputPath,
                        outputPath: config.outputPath,
                        provider: config.provider,
                        model: config.model,
                    },
                    meta: {
                        userId: req.user?.id,
                        timestamp: new Date().toISOString(),
                    },
                });
            } catch (err) {
                res.status(500).json({
                    error: 'Failed to set config',
                    message: (err as Error).message,
                });
            }
        }
    );

    /**
     * GET /curator/config
     * Get current configuration and workspace info
     */
    router.get('/curator/config', (req: Request, res: Response) => {
        try {
            const config = configManager.getConfig();
            const wsInfo = configManager.getWorkspaceInfo();
            res.json({
                inputPath: config.inputPath,
                outputPath: config.outputPath,
                provider: config.provider,
                model: config.model,
                port: config.port,
                workspace: {
                    current: wsInfo.current,
                    available: wsInfo.available.map(w => ({
                        name: w.name,
                        description: w.description,
                    })),
                },
            });
        } catch (err) {
            res.status(500).json({ error: (err as Error).message });
        }
    });

    /**
     * POST /curator/workspace/:name
     * Switch to a specific workspace
     */
    router.post('/curator/workspace/:name', (req: Request, res: Response) => {
        try {
            const workspaceName = req.params.name;
            const result = configManager.switchWorkspace(workspaceName);

            if (!result.success) {
                res.status(400).json({
                    error: 'Workspace switch failed',
                    message: result.error,
                });
                return;
            }

            const config = configManager.getConfig();
            res.json({
                success: true,
                workspace: workspaceName,
                config: {
                    inputPath: config.inputPath,
                    outputPath: config.outputPath,
                    provider: config.provider,
                    model: config.model,
                },
            });
        } catch (err) {
            res.status(500).json({
                error: 'Failed to switch workspace',
                message: (err as Error).message,
            });
        }
    });

    /**
     * GET /curator/workspaces
     * List all available workspaces
     */
    router.get('/curator/workspaces', (req: Request, res: Response) => {
        try {
            const workspaces = configManager.listWorkspaces();
            const current = configManager.getCurrentWorkspace();

            res.json({
                current,
                workspaces: workspaces.map(w => ({
                    name: w.name,
                    inputPath: w.inputPath,
                    outputPath: w.outputPath,
                    description: w.description,
                })),
            });
        } catch (err) {
            res.status(500).json({ error: (err as Error).message });
        }
    });

    /**
     * POST /curator/process
     * Curate files from input path into vault
     */
    router.post('/curator/process', async (req: Request, res: Response) => {
        try {
            const inputPath = req.body.inputPath || configManager.getInputPath();
            const outputPath = req.body.outputPath || configManager.getOutputPath();

            if (!inputPath || !outputPath) {
                res.status(400).json({
                    error: 'inputPath and outputPath must be set (via POST body or config)',
                });
                return;
            }

            // Find all files
            let files: Array<{ fullPath: string; relativePath: string }>;
            try {
                files = await findAllFiles(inputPath);
                files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
            } catch (err) {
                res.status(400).json({
                    error: `Failed to scan input path: ${(err as Error).message}`,
                });
                return;
            }

            if (files.length === 0) {
                res.json({
                    notesWritten: [],
                    notesSkipped: [],
                    errors: ['No files found in input path'],
                    filesAnalyzed: [],
                    totalFiles: 0,
                });
                return;
            }

            // Create analyzer
            const analyzer = new CodeAnalyzer({
                provider: createProvider(),
                vaultPath: outputPath,
            });

            // Process files
            const results = {
                notesWritten: [] as string[],
                notesSkipped: [] as string[],
                errors: [] as string[],
                filesAnalyzed: [] as string[],
                totalFiles: files.length,
                codeFiles: files.filter(f => isCodeFile(f.fullPath)).length,
                docFiles: files.filter(f => isDocFile(f.fullPath)).length,
                durationMs: 0,
            };

            const start = Date.now();

            for (let i = 0; i < files.length; i++) {
                const { fullPath, relativePath } = files[i];
                try {
                    const analyzed = await analyzer.analyzeFile(fullPath, relativePath, files);
                    results.notesWritten.push(...analyzed.notesWritten);
                    results.notesSkipped.push(...analyzed.notesSkipped);
                    results.errors.push(...analyzed.errors);
                    results.filesAnalyzed.push(...(analyzed.filesAnalyzed || []));
                } catch (err) {
                    results.errors.push(`${relativePath}: ${(err as Error).message}`);
                }
            }

            results.durationMs = Date.now() - start;

            res.json(results);
        } catch (err) {
            res.status(500).json({
                error: (err as Error).message,
            });
        }
    });

    // ── Status Endpoints ─────────────────────────────────────────────────────

    /**
     * GET /status
     * Get overall system status
     */
    router.get('/status', (req: Request, res: Response) => {
        try {
            const config = configManager.getConfig();
            res.json({
                status: 'ready',
                curator: {
                    inputPath: config.inputPath || 'not set',
                    outputPath: config.outputPath,
                    provider: config.provider,
                    model: config.model,
                },
                server: {
                    port: config.port,
                    timestamp: new Date().toISOString(),
                },
            });
        } catch (err) {
            res.status(500).json({
                error: (err as Error).message,
            });
        }
    });

    /**
     * GET /health
     * Health check (for load balancers, monitoring)
     */
    router.get('/health', (req: Request, res: Response) => {
        res.json({ status: 'ok', timestamp: new Date().toISOString() });
    });

    // ── Knowledge / RAG Endpoints ────────────────────────────────────────────

    /**
     * POST /knowledge/search
     * Semantic search across a vault
     * Body: { vaultPath, query, topK? }
     */
    router.post('/knowledge/search', validateBody(KnowledgeSearchWithVaultSchema), async (req: Request, res: Response) => {
        try {
            const { vaultPath, query, topK } = (req as any).validatedBody;
            const engine = await getEngine(vaultPath);
            const result = await engine.search(query, { topK, autoSynthesize: false });
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: 'Search failed', message: (err as Error).message });
        }
    });

    /**
     * POST /knowledge/reindex
     * Rebuild the RAG index for a vault
     * Body: { vaultPath }
     */
    router.post('/knowledge/reindex', validateBody(KnowledgeReindexSchema), async (req: Request, res: Response) => {
        try {
            const { vaultPath } = (req as any).validatedBody;
            const engine = engineCache.get(vaultPath) ?? new KnowledgeEngine(createProvider(), vaultPath);
            const result = await engine.reload();
            engineCache.set(vaultPath, engine);
            res.json(result);
        } catch (err) {
            res.status(500).json({ error: 'Reindex failed', message: (err as Error).message });
        }
    });

    /**
     * POST /curator/file
     * Curate a single file and write the result to a vault
     * Body: { vaultPath, fileName, content }
     */
    router.post('/curator/file', validateBody(CuratorFileSchema), async (req: Request, res: Response) => {
        const { vaultPath, fileName, content } = (req as any).validatedBody;
        const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'curator-file-'));
        try {
            const tmpFile = path.join(tmpDir, fileName);
            await fsp.writeFile(tmpFile, content, 'utf-8');

            const analyzer = new CodeAnalyzer({ provider: createProvider(), vaultPath });
            const result   = await analyzer.analyzeFile(tmpFile, fileName);

            let generatedContent: string | null = null;
            let generatedTitle:   string | null = null;
            let tags: string[] = [];
            let area = 'general';

            if (result.notesWritten.length > 0) {
                const notePath = result.notesWritten[0];
                generatedContent = await fsp.readFile(notePath, 'utf-8').catch(() => null);
                generatedTitle   = path.basename(notePath, '.md')
                    .replace(/^\d{4}-\d{2}-\d{2}-/, '')
                    .replace(/-/g, ' ');
                const rel   = path.relative(vaultPath, notePath);
                const parts = rel.split(path.sep);
                area = parts.length > 1 ? parts[0] : 'general';
                if (generatedContent) {
                    const fmMatch  = generatedContent.match(/^---\n([\s\S]*?)\n---/);
                    const tagsLine = fmMatch?.[1].match(/^tags:\s*\[([^\]]*)\]/m);
                    if (tagsLine) {
                        tags = tagsLine[1].split(',').map(t => t.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
                    }
                }
            }

            res.json({ ...result, generatedContent, generatedTitle, tags, area });
        } catch (err) {
            res.status(500).json({ error: 'Curation failed', message: (err as Error).message });
        } finally {
            await fsp.rm(tmpDir, { recursive: true }).catch(() => {});
        }
    });

    // ── Agent Protocol v1 ────────────────────────────────────────────────────
    // Implements HTTP Agent Protocol v1 so orchestrator-mcp-agent can call curator
    // as a first-class HTTP agent via AgentClient / AgentPool.

    const AGENT_VERSION = '0.2.0';

    // Lightweight in-process task store for async v1 tasks
    const v1Tasks = new Map<string, {
        status:      'pending' | 'running' | 'done' | 'failed' | 'cancelled';
        output?:     unknown;
        error?:      string;
        startedAt:   string;
        finishedAt?: string;
        durationMs?: number;
    }>();

    const v1ok = <T>(data: T, meta: Record<string, unknown> = {}) =>
        ({ ok: true, data, error: null, meta: { agentVersion: AGENT_VERSION, ...meta } });

    const v1err = (code: string, message: string, status = 400) =>
        [{ ok: false, data: null, error: { code, message }, meta: { agentVersion: AGENT_VERSION } }, status] as const;

    /**
     * GET /v1/agent/health
     */
    router.get('/v1/agent/health', (_req: Request, res: Response) => {
        res.json(v1ok({ status: 'ok', uptime: process.uptime() }));
    });

    /**
     * GET /v1/agent/info
     */
    router.get('/v1/agent/info', (_req: Request, res: Response) => {
        res.json(v1ok({
            name:        'curator-codex-agent',
            version:     AGENT_VERSION,
            description: 'Knowledge curation and RAG search over Obsidian-style vaults',
            capabilities: [
                {
                    name:        'execute',
                    description: 'Run a knowledge task: searches vault using prior_results context',
                    async:       false,
                    input:       { task: 'string', flow_input: 'object?', prior_results: 'array?' },
                    output:      'string',
                },
                {
                    name:        'search',
                    description: 'Semantic search across a vault',
                    async:       false,
                    input:       { query: 'string', vault_path: 'string?', topK: 'number?' },
                    output:      'object',
                },
                {
                    name:        'reindex',
                    description: 'Rebuild the vault search index',
                    async:       true,
                    input:       { vault_path: 'string?' },
                    output:      'object',
                },
            ],
        }, { agentVersion: AGENT_VERSION }));
    });

    /**
     * POST /v1/agent/run
     * Dispatches to: execute | search | reindex
     */
    router.post('/v1/agent/run', async (req: Request, res: Response) => {
        const start      = Date.now();
        const { capability, input = {}, async: runAsync = false } = req.body as {
            capability?: string;
            input?:      Record<string, unknown>;
            async?:      boolean;
        };

        if (!capability) {
            const [body, status] = v1err('INVALID_INPUT', "Missing 'capability' field");
            return res.status(status).json(body);
        }

        const meta = () => ({ agentVersion: AGENT_VERSION, durationMs: Date.now() - start });

        try {
            switch (capability) {

                case 'execute': {
                    const task        = String(input.task ?? '');
                    const flowInput   = (input.flow_input  ?? {}) as Record<string, unknown>;
                    const priorRes    = (input.prior_results ?? []) as Array<{ step: string; agent: string; output: string }>;
                    const vaultPath   = String(input.vault_path ?? flowInput.vault_path ?? configManager.getOutputPath());

                    // Extract search query: try to parse JSON output from prior classify step
                    let query = String(flowInput.question ?? flowInput.query ?? task);
                    for (const r of [...priorRes].reverse()) {
                        try {
                            const parsed = JSON.parse(r.output) as Record<string, unknown>;
                            if (typeof parsed.query === 'string' && parsed.query) { query = parsed.query; break; }
                        } catch { /* not JSON, use as-is */ }
                        // Fallback: treat raw string as query
                        if (r.output && typeof r.output === 'string' && r.output.length < 200) {
                            query = r.output;
                            break;
                        }
                    }

                    const engine  = await getEngine(vaultPath);
                    const result  = await engine.search(query, { topK: 5, autoSynthesize: false });

                    if (!result.results || result.results.length === 0) {
                        return res.json(v1ok({ status: 'done', output: `No knowledge found for: "${query}"` }, meta()));
                    }

                    const text = result.results
                        .map((r: { title: string; content: string }, i: number) =>
                            `### [${i + 1}] ${r.title}\n${r.content.slice(0, 500)}`)
                        .join('\n\n');

                    return res.json(v1ok({ status: 'done', output: text }, meta()));
                }

                case 'search': {
                    const query     = String(input.query ?? input.task ?? '');
                    const vaultPath = String(input.vault_path ?? input.vaultPath ?? configManager.getOutputPath());
                    const topK      = Number(input.topK ?? input.top_k ?? 5);

                    if (!query) {
                        const [body, status] = v1err('INVALID_INPUT', "'query' is required for search capability");
                        return res.status(status).json(body);
                    }

                    const engine = await getEngine(vaultPath);
                    const result = await engine.search(query, { topK, autoSynthesize: false });
                    return res.json(v1ok({ status: 'done', output: result }, meta()));
                }

                case 'reindex': {
                    const vaultPath = String(input.vault_path ?? input.vaultPath ?? configManager.getOutputPath());

                    if (!runAsync) {
                        const engine = engineCache.get(vaultPath) ?? new KnowledgeEngine(createProvider(), vaultPath);
                        const result = await engine.reload();
                        engineCache.set(vaultPath, engine);
                        return res.json(v1ok({ status: 'done', output: result }, meta()));
                    }

                    // Async path
                    const taskId = crypto.randomUUID();
                    const now    = new Date().toISOString();
                    v1Tasks.set(taskId, { status: 'pending', startedAt: now });
                    res.json(v1ok({ status: 'running', taskId }, { agentVersion: AGENT_VERSION }));

                    setImmediate(async () => {
                        v1Tasks.get(taskId)!.status = 'running';
                        try {
                            const engine = engineCache.get(vaultPath) ?? new KnowledgeEngine(createProvider(), vaultPath);
                            const result = await engine.reload();
                            engineCache.set(vaultPath, engine);
                            const t = v1Tasks.get(taskId)!;
                            t.status     = 'done';
                            t.output     = result;
                            t.finishedAt = new Date().toISOString();
                            t.durationMs = Date.now() - start;
                        } catch (err) {
                            const t = v1Tasks.get(taskId)!;
                            t.status     = 'failed';
                            t.error      = (err as Error).message;
                            t.finishedAt = new Date().toISOString();
                        }
                    });
                    return;
                }

                default: {
                    const [body, status] = v1err('CAPABILITY_NOT_FOUND', `Capability '${capability}' not found`);
                    return res.status(status).json(body);
                }
            }
        } catch (err) {
            const [body] = v1err('EXECUTION_FAILED', (err as Error).message);
            return res.status(500).json({ ...body, error: { code: 'EXECUTION_FAILED', message: (err as Error).message } });
        }
    });

    /**
     * GET /v1/agent/tasks/:id
     */
    router.get('/v1/agent/tasks/:id', (req: Request, res: Response) => {
        const task = v1Tasks.get(req.params.id);
        if (!task) {
            const [body] = v1err('TASK_NOT_FOUND', `Task '${req.params.id}' not found`);
            return res.status(404).json(body);
        }
        res.json(v1ok({ taskId: req.params.id, ...task }));
    });

    /**
     * DELETE /v1/agent/tasks/:id
     */
    router.delete('/v1/agent/tasks/:id', (req: Request, res: Response) => {
        const task = v1Tasks.get(req.params.id);
        if (!task) {
            const [body] = v1err('TASK_NOT_FOUND', `Task '${req.params.id}' not found`);
            return res.status(404).json(body);
        }
        task.status = 'cancelled';
        res.json(v1ok({ taskId: req.params.id, status: 'cancelled' }));
    });

    // ── Error Handler ────────────────────────────────────────────────────────

    router.use((req: Request, res: Response) => {
        res.status(404).json({
            error: `Route not found: ${req.method} ${req.path}`,
            availableRoutes: [
                'GET  /health',
                'GET  /status',
                'GET  /curator/config',
                'POST /curator/config',
                'POST /curator/process',
                'POST /curator/file',
                'POST /knowledge/search',
                'POST /knowledge/reindex',
                'GET  /v1/agent/health',
                'GET  /v1/agent/info',
                'POST /v1/agent/run',
                'GET  /v1/agent/tasks/:id',
            ],
        });
    });

    return router;
}
