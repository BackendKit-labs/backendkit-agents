#!/usr/bin/env node
/**
 * curator-watcher — autonomous vault ingestion service
 *
 * Watches vault/incoming/ for new files and curates them automatically.
 * Also starts an optional HTTP webhook server for n8n / external triggers.
 *
 * Required env vars:
 *   CURATOR_API_KEY    — DeepSeek / OpenAI-compatible API key
 *   CURATOR_VAULT_PATH — absolute path to the shared vault (where notes are written)
 *
 * Optional:
 *   CURATOR_INPUT_PATH  — path to documents to curate (if set: process once; if not: watch vault/incoming/)
 *   CURATOR_MODEL       — LLM model (default: deepseek-reasoner)
 *   CURATOR_BASE_URL    — LLM base URL (default: DeepSeek API)
 *   CURATOR_HTTP_PORT   — start HTTP webhook server on this port (e.g. 3099)
 *   CURATOR_POLL_MS     — polling interval in ms (default: 30 000)
 *
 * Modes:
 *   Mode 1 (Watcher):  no CURATOR_INPUT_PATH → watch vault/incoming/ for new files
 *   Mode 2 (Direct):   CURATOR_INPUT_PATH set → process documents once with progress bar
 *
 * Run:
 *   # Mode 1: Watch incoming/
 *   CURATOR_API_KEY=sk-... CURATOR_VAULT_PATH=/vault node dist/watcher.js
 *
 *   # Mode 2: Direct input path with progress
 *   CURATOR_INPUT_PATH=/docs CURATOR_VAULT_PATH=/vault CURATOR_API_KEY=sk-... node dist/watcher.js
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
import { createProvider }   from './providers/index.js';
import { ProgressBar }      from '@backendkit-labs/console-animations';
import type { CurationResult } from './types.js';

// ── Config ─────────────────────────────────────────────────────────────────────

const VAULT_PATH    = process.env.CURATOR_VAULT_PATH ?? '';
const INPUT_PATH    = process.env.CURATOR_INPUT_PATH ?? null;
const HTTP_PORT     = process.env.CURATOR_HTTP_PORT ? parseInt(process.env.CURATOR_HTTP_PORT) : null;
const POLL_MS       = parseInt(process.env.CURATOR_POLL_MS ?? '30000');
const USE_INCOMING  = !INPUT_PATH; // true if INPUT_PATH not set, use vault/incoming/ mode

function validate(): void {
    if (!process.env.CURATOR_API_KEY) { console.error('✗  CURATOR_API_KEY is required'); process.exit(1); }
    if (!VAULT_PATH)                  { console.error('✗  CURATOR_VAULT_PATH is required'); process.exit(1); }
    if (INPUT_PATH) {
        try {
            fsSync.accessSync(INPUT_PATH, fsSync.constants.R_OK);
        } catch {
            console.error(`✗  CURATOR_INPUT_PATH not readable: ${INPUT_PATH}`); process.exit(1);
        }
    }
}

function makeCurator(): KnowledgeCurator {
    return new KnowledgeCurator({ provider: createProvider(), vaultPath: VAULT_PATH });
}

function log(msg: string): void {
    console.log(`[curator-watcher] ${new Date().toISOString().slice(11, 19)}  ${msg}`);
}

function summarise(r: CurationResult, label: string): void {
    if (r.notesWritten.length)  log(`  ✓ ${label} — wrote: ${r.notesWritten.map(p => path.basename(p)).join(', ')}`);
    if (r.notesSkipped.length)  log(`  ○ ${label} — skipped (exists): ${r.notesSkipped.join(', ')}`);
    if (r.errors.length)        log(`  ✗ ${label} — errors: ${r.errors.join(' | ')}`);
}

// ── Process input directory with progress bar ─────────────────────────────────

async function processInputDirectory(): Promise<void> {
    if (!INPUT_PATH) return;

    let files: string[];
    try {
        const entries = await fs.readdir(INPUT_PATH);
        files = entries.filter(f => f.endsWith('.md') || f.endsWith('.txt')).sort();
    } catch (err) {
        log(`✗ Failed to read INPUT_PATH: ${(err as Error).message}`);
        return;
    }

    if (files.length === 0) {
        log(`ℹ  No markdown/text files found in ${INPUT_PATH}`);
        return;
    }

    log(`\n📚 Processing ${files.length} files from ${INPUT_PATH}`);
    const progress = new ProgressBar({
        total: files.length,
        width: 50,
        label: 'Curation Progress'
    });

    let processed = 0;
    let succeeded = 0;
    let failed = 0;

    for (const file of files) {
        const filePath = path.join(INPUT_PATH, file);
        try {
            const curator = makeCurator();
            await curator.curateFile(filePath);
            succeeded++;
        } catch (err) {
            log(`  ✗ ${file} — error: ${(err as Error).message}`);
            failed++;
        }
        processed++;
        progress.update(processed);
    }

    progress.complete();
    log(`\n✓ Curation complete: ${succeeded} succeeded, ${failed} failed\n`);
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
    if (USE_INCOMING) {
        // Traditional mode: watch vault/incoming/
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
    } else {
        // Direct mode: process INPUT_PATH once with progress bar
        processInputDirectory();
    }
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
log(`Vault:    ${VAULT_PATH}`);
log(`Mode:     ${USE_INCOMING ? 'Watch vault/incoming/' : 'Process INPUT_PATH once'}`);
if (INPUT_PATH) log(`Input:    ${INPUT_PATH}`);
log(`Provider: ${process.env.CURATOR_PROVIDER ?? 'deepseek'}`);
log(`Model:    ${process.env.CURATOR_MODEL ?? 'deepseek-reasoner'}`);

startPolling();
if (HTTP_PORT) startHttpServer(HTTP_PORT);
