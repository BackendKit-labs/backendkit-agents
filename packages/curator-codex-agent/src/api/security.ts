/**
 * Security middleware for Curator-Codex HTTP API
 * Handles authentication, rate limiting, and input validation
 */

import { Request, Response, NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import * as crypto from 'node:crypto';

// ── Authentication ──────────────────────────────────────────────────────────

export interface AuthenticatedRequest extends Request {
    user?: {
        id: string;
        key: string;
        rateLimit: number;
    };
}

/**
 * Bearer token authentication middleware
 * Validates API key from Authorization header
 */
export function createAuthMiddleware(apiKeys: Map<string, { rateLimit: number }> = new Map()) {
    return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        const authHeader = req.headers.authorization;

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            // No auth required for health/status endpoints
            if (req.path === '/health' || req.path === '/status' || req.path === '/' || req.path === '/v1/agent/health') {
                return next();
            }
            return res.status(401).json({
                error: 'Unauthorized',
                message: 'Missing or invalid Authorization header',
                expected: 'Authorization: Bearer sk-...',
            });
        }

        const token = authHeader.slice(7); // Remove "Bearer "

        // Validate token format
        if (!token.startsWith('sk-') || token.length < 20) {
            return res.status(401).json({
                error: 'Unauthorized',
                message: 'Invalid API key format',
            });
        }

        // Check token (in production, verify against DB/KMS)
        const keyInfo = apiKeys.get(token) || { rateLimit: 100 };

        req.user = {
            id: hashToken(token),
            key: token.slice(0, 10) + '...',
            rateLimit: keyInfo.rateLimit,
        };

        next();
    };
}

function hashToken(token: string): string {
    return crypto.createHash('sha256').update(token).digest('hex').slice(0, 12);
}

// ── Rate Limiting ──────────────────────────────────────────────────────────

export function createRateLimiter(windowMs: number = 15 * 60 * 1000, max: number = 100) {
    return rateLimit({
        windowMs,
        max,
        message: {
            error: 'Too many requests',
            message: 'Rate limit exceeded. Please try again later.',
            retryAfter: Math.ceil(windowMs / 1000),
        },
        standardHeaders: true, // Return rate limit info in headers
        skip: (req) => {
            // Skip rate limiting for health checks
            return req.path === '/health';
        },
    });
}

// ── Input Validation ───────────────────────────────────────────────────────

export const CuratorConfigSchema = z.object({
    inputPath: z.string().min(1).describe('Input directory path'),
    outputPath: z.string().min(1).describe('Output vault path'),
});

export const CuratorProcessSchema = z.object({
    inputPath: z.string().optional().describe('Optional input override'),
    outputPath: z.string().optional().describe('Optional output override'),
});

export const KnowledgeSearchSchema = z.object({
    query: z.string().min(3).max(500).describe('Search query'),
    topK: z.number().int().min(1).max(20).optional().describe('Top K results'),
    autoSynthesize: z.boolean().optional().describe('Auto-generate synthesis'),
});

export const KnowledgeSearchWithVaultSchema = z.object({
    vaultPath: z.string().min(1).describe('Absolute path to vault directory'),
    query:     z.string().min(3).max(500).describe('Search query'),
    topK:      z.number().int().min(1).max(20).optional().default(5),
});

export const KnowledgeReindexSchema = z.object({
    vaultPath: z.string().min(1).describe('Absolute path to vault directory'),
});

export const CuratorFileSchema = z.object({
    vaultPath: z.string().min(1).describe('Absolute path to vault directory'),
    fileName:  z.string().min(1).max(255).describe('Original file name'),
    content:   z.string().min(1).describe('File content to curate'),
});

export type CuratorConfig        = z.infer<typeof CuratorConfigSchema>;
export type CuratorProcess       = z.infer<typeof CuratorProcessSchema>;
export type KnowledgeSearch      = z.infer<typeof KnowledgeSearchSchema>;
export type KnowledgeSearchWithVault = z.infer<typeof KnowledgeSearchWithVaultSchema>;
export type KnowledgeReindex     = z.infer<typeof KnowledgeReindexSchema>;
export type CuratorFile          = z.infer<typeof CuratorFileSchema>;

/**
 * Validate request body against schema
 */
export function validateBody<T>(schema: z.ZodSchema) {
    return (req: Request, res: Response, next: NextFunction) => {
        try {
            const validated = schema.parse(req.body);
            (req as any).validatedBody = validated;
            next();
        } catch (err) {
            if (err instanceof z.ZodError) {
                return res.status(400).json({
                    error: 'Validation failed',
                    details: err.errors.map(e => ({
                        field: e.path.join('.'),
                        message: e.message,
                        code: e.code,
                    })),
                });
            }
            res.status(400).json({
                error: 'Invalid request',
                message: (err as Error).message,
            });
        }
    };
}

// ── Request Logging ────────────────────────────────────────────────────────

export function createRequestLogger() {
    return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
        const start = Date.now();

        // Log request
        const userId = req.user?.id || 'anonymous';
        console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} (${userId})`);

        // Intercept response
        const originalJson = res.json.bind(res);
        res.json = function (body: any) {
            const duration = Date.now() - start;
            console.log(
                `[${new Date().toISOString()}] ${req.method} ${req.path} → ${res.statusCode} (${duration}ms)`
            );
            return originalJson(body);
        };

        next();
    };
}

// ── Error Handler ──────────────────────────────────────────────────────────

export function errorHandler(
    err: Error | any,
    req: Request,
    res: Response,
    next: NextFunction
) {
    const status = err.status || 500;
    const message = err.message || 'Internal server error';

    console.error(
        `[ERROR] ${req.method} ${req.path} → ${status}`,
        { error: message, stack: err.stack }
    );

    res.status(status).json({
        error: status >= 500 ? 'Server error' : 'Client error',
        message,
        ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
    });
}

// ── Request Context ────────────────────────────────────────────────────────

export interface RequestContext {
    userId: string;
    requestId: string;
    startTime: number;
    ip: string;
}

export function createRequestContext(req: AuthenticatedRequest): RequestContext {
    return {
        userId: req.user?.id || 'anonymous',
        requestId: crypto.randomUUID(),
        startTime: Date.now(),
        ip: (req.ip || req.socket.remoteAddress || 'unknown') as string,
    };
}
