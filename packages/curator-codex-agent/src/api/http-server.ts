/**
 * Curator-Codex HTTP Server
 * Unified API for curation and knowledge management
 */

import express, { Express } from 'express';
import { createRoutes } from './routes.js';
import { ConfigManager, type ApiConfig } from './config.js';
import {
    createAuthMiddleware,
    createRateLimiter,
    createRequestLogger,
    errorHandler,
    type AuthenticatedRequest,
} from './security.js';

export interface HttpServerOptions {
    port?: number;
    apiConfig?: Partial<ApiConfig>;
}

export class CuratorHttpServer {
    private app: Express;
    private configManager: ConfigManager;
    private port: number;
    private server: any = null;

    constructor(opts: HttpServerOptions = {}) {
        this.app = express();
        this.configManager = new ConfigManager(opts.apiConfig);
        this.port = opts.port || this.configManager.getConfig().port;

        this.setupMiddleware();
        this.setupRoutes();
    }

    private setupMiddleware(): void {
        // Parse JSON (limit to 10MB)
        this.app.use(express.json({ limit: '10mb' }));

        // Request logging
        this.app.use(createRequestLogger());

        // CORS
        this.app.use((req, res, next) => {
            res.header('Access-Control-Allow-Origin', '*');
            res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
            res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
            if (req.method === 'OPTIONS') {
                res.sendStatus(200);
            } else {
                next();
            }
        });

        // Authentication middleware
        this.app.use(createAuthMiddleware());

        // Rate limiting (100 requests per 15 minutes)
        this.app.use(createRateLimiter(15 * 60 * 1000, 100));

        // Request ID tracking
        this.app.use((req: AuthenticatedRequest, res, next) => {
            req.id = require('crypto').randomUUID();
            res.setHeader('X-Request-ID', req.id);
            next();
        });
    }

    private setupRoutes(): void {
        // Root
        this.app.get('/', (req, res) => {
            res.json({
                name: 'curator-codex-agent',
                version: '0.1.0',
                description: 'Unified code + documentation curation with knowledge extraction',
                endpoints: {
                    health: 'GET  /health',
                    status: 'GET  /status',
                    config: ['GET  /curator/config', 'POST /curator/config'],
                    curation: ['POST /curator/process'],
                    docs: 'https://github.com/BackendKit-labs/backendkit-agents#curator-codex',
                },
            });
        });

        // Mount all routes
        this.app.use('/', createRoutes(this.configManager));

        // Error handler (must be last)
        this.app.use(errorHandler);
    }

    async start(): Promise<void> {
        return new Promise((resolve) => {
            this.server = this.app.listen(this.port, () => {
                console.log(`\n╔════════════════════════════════════════╗`);
                console.log(`║  Curator-Codex HTTP Server              ║`);
                console.log(`╠════════════════════════════════════════╣`);
                console.log(`║  🚀 Server running                       ║`);
                console.log(`║  📍 http://localhost:${this.port}                      ║`);
                console.log(`║  📚 GET /status for config               ║`);
                console.log(`╚════════════════════════════════════════╝\n`);
                resolve();
            });
        });
    }

    async stop(): Promise<void> {
        if (this.server) {
            return new Promise((resolve) => {
                this.server.close(() => {
                    console.log('Server stopped');
                    resolve();
                });
            });
        }
    }

    getConfigManager(): ConfigManager {
        return this.configManager;
    }

    getApp(): Express {
        return this.app;
    }
}
