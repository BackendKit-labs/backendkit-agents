/**
 * HTTP API Routes for Curator-Codex
 * Handles curation and knowledge management endpoints
 */

import { Router, Request, Response } from 'express';
import { CodeAnalyzer } from '../analyzer.js';
import { createProvider } from '../providers/index.js';
import { findAllFiles, isCodeFile, isDocFile } from '../checksum.js';
import type { ConfigManager } from './config.js';
import {
    validateBody,
    CuratorConfigSchema,
    CuratorProcessSchema,
    KnowledgeSearchSchema,
    type AuthenticatedRequest,
} from './security.js';

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
            ],
        });
    });

    return router;
}
