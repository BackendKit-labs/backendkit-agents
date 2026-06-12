#!/usr/bin/env node
/**
 * curator-watcher — autonomous vault ingestion service
 *
 * Watches vault/incoming/ for new files and curates them automatically.
 * Also starts an optional HTTP webhook server for n8n / external triggers.
 *
 * Required env vars:
 *   CURATOR_API_KEY    — DeepSeek / OpenAI-compatible API key
 *   CURATOR_VAULT_PATH — absolute path to the shared vault
 *
 * Optional:
 *   CURATOR_MODEL       — LLM model (default: deepseek-chat)
 *   CURATOR_BASE_URL    — LLM base URL (default: DeepSeek API)
 *   CURATOR_HTTP_PORT   — start HTTP webhook server on this port (e.g. 3099)
 *   CURATOR_POLL_MS     — polling interval in ms (default: 30 000)
 *
 * Run:
 *   CURATOR_API_KEY=sk-... CURATOR_VAULT_PATH=/vault node dist/watcher.js
 *
 * Webhook (when CURATOR_HTTP_PORT is set):
 *   POST http://localhost:3099/ingest
 *   Body: { "text": "...", "source": "filename.pdf" }
 *   OR:   { "file_path": "/absolute/path/to/file.txt" }
 */

import * as fs       from 'node:fs/promises';
import * as fsSync   from 'node:fs';
import * as path     from 'node:path';
import * as http     from 'node:http';
import { KnowledgeCurator } from './curator.js';
import type { CurationResult } from './types.js';

// ── Config ─────────────────────────────────────────────────────────────────────

const API_KEY    = process.env.CURATOR_API_KEY    ?? '';
const VAULT_PATH = process.env.CURATOR_VAULT_PATH ?? '';
const MODEL      = process.env.CURATOR_MODEL;
const BASE_URL   = process.env.CURATOR_BASE_URL;
const HTTP_PORT  = process.env.CURATOR_HTTP_PORT ? parseInt(process.env.CURATOR_HTTP_PORT) : null;
const POLL_MS    = parseInt(process.env.CURATOR_POLL_MS ?? '30000');

function validate(): void {
    if (!API_KEY)    { console.error('✗  CURATOR_API_KEY is required'); process.exit(1); }
    if (!VAULT_PATH) { console.error('✗  CURATOR_VAULT_PATH is required'); process.exit(1); }
}

function makeCurator(): KnowledgeCurator {
    return new KnowledgeCurator({ apiKey: API_KEY, vaultPath: VAULT_PATH, model: MODEL, baseUrl: BASE_URL });
}

function log(msg: string): void {
    console.log(`[curator-watcher] ${new Date().toISOString().slice(11, 19)}  ${msg}`);
}

function summarise(r: CurationResult, label: string): void {
    if (r.notesWritten.length)  log(`  ✓ ${label} — wrote: ${r.notesWritten.map(p => path.basename(p)).join(', ')}`);
    if (r.notesSkipped.length)  log(`  ○ ${label} — skipped (exists): ${r.notesSkipped.join(', ')}`);
    if (r.errors.length)        log(`  ✗ ${label} — errors: ${r.errors.join(' | ')}`);
}

// ── File watcher (poll-based, works reliably on Windows) ─────────────────────

const INCOMING = path.join(VAULT_PATH, 'incoming');
const processing = new Set<string>();

async function scanIncoming(): Promise<void> {
    let files: string[];
    try {
        files = (await fs.readdir(INCOMING)).filter(f => !f.startsWith('.'));
    } catch {
        return; // incoming/ doesn't exist yet — OK
    }

    for (const file of files) {
        const filePath = path.join(INCOMING, file);
        if (processing.has(filePath)) continue;

        // Only process regular files (skip subdirs)
        try {
            const stat = await fs.stat(filePath);
            if (!stat.isFile()) continue;
        } catch { continue; }

        processing.add(filePath);
        log(`Processing: ${file}`);

        try {
            const curator = makeCurator();
            const result  = await curator.curateFile(filePath);
            summarise(result, file);
        } catch (err) {
            log(`  ✗ ${file} — fatal: ${(err as Error).message}`);
        } finally {
            processing.delete(filePath);
        }
    }
}

function startPolling(): void {
    // Ensure incoming/ exists
    fsSync.mkdirSync(INCOMING, { recursive: true });
    log(`Watching ${INCOMING} (poll every ${POLL_MS / 1000}s)`);

    // Also use fs.watch for immediate pickup on supported platforms
    try {
        fsSync.watch(INCOMING, { persistent: true }, (_, filename) => {
            if (filename && !filename.startsWith('.')) {
                setTimeout(scanIncoming, 500); // small delay so file is fully written
            }
        });
    } catch {
        log('fs.watch unavailable — using poll only');
    }

    // Polling as reliable fallback
    setInterval(scanIncoming, POLL_MS);

    // Initial scan on startup
    scanIncoming();
}

// ── HTTP webhook server ───────────────────────────────────────────────────────

function startHttpServer(port: number): void {
    const server = http.createServer(async (req, res) => {
        if (req.method !== 'POST' || req.url !== '/ingest') {
            res.writeHead(404).end('Not found');
            return;
        }

        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', async () => {
            let payload: { text?: string; source?: string; file_path?: string };
            try {
                payload = JSON.parse(body);
            } catch {
                res.writeHead(400).end(JSON.stringify({ error: 'Invalid JSON' }));
                return;
            }

            const curator = makeCurator();
            let result: CurationResult;

            try {
                if (payload.file_path) {
                    result = await curator.curateFile(payload.file_path);
                } else if (payload.text) {
                    result = await curator.curateText(payload.text, payload.source ?? 'webhook');
                } else {
                    res.writeHead(400).end(JSON.stringify({ error: '"text" or "file_path" required' }));
                    return;
                }

                const source = payload.file_path ? path.basename(payload.file_path) : (payload.source ?? 'webhook');
                summarise(result, source);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(result));
            } catch (err) {
                res.writeHead(500).end(JSON.stringify({ error: (err as Error).message }));
            }
        });
    });

    server.listen(port, () => {
        log(`HTTP webhook server on http://localhost:${port}/ingest`);
        log('n8n: POST { "text": "...", "source": "filename.pdf" }');
    });
}

// ── Main ──────────────────────────────────────────────────────────────────────

validate();
log(`Vault: ${VAULT_PATH}`);
log(`Model: ${MODEL ?? 'deepseek-chat'}`);

startPolling();
if (HTTP_PORT) startHttpServer(HTTP_PORT);
