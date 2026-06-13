#!/usr/bin/env node
/**
 * curator-codex-http — HTTP server for unified curation + knowledge
 *
 * Required env vars:
 *   CURATOR_API_KEY      — LLM API key
 *   CURATOR_OUTPUT_PATH  — Vault path
 *
 * Optional:
 *   CURATOR_INPUT_PATH   — Code/doc directory to curate
 *   CURATOR_HTTP_PORT    — Server port (default: 3100)
 *   CURATOR_PROVIDER     — LLM provider (default: deepseek)
 *   CURATOR_MODEL        — LLM model (default: deepseek-reasoner)
 *   CURATOR_BASE_URL     — Custom LLM base URL
 *
 * Usage:
 *   npm run http-server
 *   CURATOR_OUTPUT_PATH=/vault CURATOR_API_KEY=sk-... npm run http-server
 *
 * API Examples:
 *   GET  http://localhost:3100/              # Info
 *   GET  http://localhost:3100/status        # Status
 *   GET  http://localhost:3100/curator/config
 *   POST http://localhost:3100/curator/config
 *   POST http://localhost:3100/curator/process
 */

import 'dotenv/config';
import { CuratorHttpServer } from './api/http-server.js';

async function main(): Promise<void> {
    const outputPath = process.env.CURATOR_OUTPUT_PATH;
    const port = process.env.CURATOR_HTTP_PORT ? parseInt(process.env.CURATOR_HTTP_PORT) : 3100;

    if (!outputPath) {
        console.error('✗ CURATOR_OUTPUT_PATH is required');
        process.exit(1);
    }

    if (!process.env.CURATOR_API_KEY) {
        console.error('✗ CURATOR_API_KEY is required');
        process.exit(1);
    }

    const server = new CuratorHttpServer({
        port,
        apiConfig: {
            inputPath: process.env.CURATOR_INPUT_PATH,
            outputPath,
            provider: process.env.CURATOR_PROVIDER,
            model: process.env.CURATOR_MODEL,
            baseUrl: process.env.CURATOR_BASE_URL,
        },
    });

    await server.start();

    // Graceful shutdown
    process.on('SIGINT', async () => {
        console.log('\n\n  Shutting down...');
        await server.stop();
        process.exit(0);
    });

    process.on('SIGTERM', async () => {
        console.log('\n\n  Shutting down...');
        await server.stop();
        process.exit(0);
    });
}

main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
});
