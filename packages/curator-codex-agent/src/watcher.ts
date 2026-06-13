#!/usr/bin/env node
/**
 * curator-codex-watcher — autonomous code analysis service
 *
 * Analyzes source code files recursively, extracts knowledge, and curates into vault.
 *
 * Required env vars:
 *   CURATOR_API_KEY      — DeepSeek / OpenAI-compatible API key
 *   CURATOR_OUTPUT_PATH  — absolute path to the shared vault (where notes are written)
 *
 * Optional:
 *   CURATOR_INPUT_PATH   — path to code to analyze (if set: process once; if not: watch vault/incoming/)
 *   CURATOR_MODEL        — LLM model (default: deepseek-reasoner)
 *   CURATOR_BASE_URL     — LLM base URL
 *   CURATOR_POLL_MS      — polling interval in ms (default: 30 000)
 *
 * Modes:
 *   Mode 1 (Watcher):  no CURATOR_INPUT_PATH → watch vault/incoming/ for new files
 *   Mode 2 (Direct):   CURATOR_INPUT_PATH set → process code once with progress bar
 *
 * Run:
 *   # Mode 2: Direct code analysis
 *   CURATOR_INPUT_PATH=/project CURATOR_OUTPUT_PATH=/vault CURATOR_API_KEY=sk-... node dist/watcher.js
 */

import * as fs       from 'node:fs/promises';
import * as fsSync   from 'node:fs';
import * as path     from 'node:path';
import { CodeAnalyzer } from './analyzer.js';
import { createProvider } from './providers/index.js';
import {
    loadManifest,
    saveManifest,
    createManifest,
    hasFileChanged,
    updateManifestEntry,
    generateReport,
    findAllFiles,
} from './checksum.js';

const VAULT_PATH    = process.env.CURATOR_OUTPUT_PATH ?? '';
const INPUT_PATH    = process.env.CURATOR_INPUT_PATH ?? null;
const POLL_MS       = parseInt(process.env.CURATOR_POLL_MS ?? '30000');

function validate(): void {
    if (!process.env.CURATOR_API_KEY) { console.error('✗  CURATOR_API_KEY is required'); process.exit(1); }
    if (!VAULT_PATH)                  { console.error('✗  CURATOR_OUTPUT_PATH is required'); process.exit(1); }
    if (INPUT_PATH) {
        try {
            fsSync.accessSync(INPUT_PATH, fsSync.constants.R_OK);
        } catch {
            console.error(`✗  CURATOR_INPUT_PATH not readable: ${INPUT_PATH}`); process.exit(1);
        }
    }
}

function makeAnalyzer(): CodeAnalyzer {
    return new CodeAnalyzer({ provider: createProvider(), vaultPath: VAULT_PATH });
}

function log(msg: string): void {
    console.log(`[codex-watcher] ${new Date().toISOString().slice(11, 19)}  ${msg}`);
}

function buildProgressBar(current: number, total: number, width: number = 40): string {
    const percent = Math.round((current / total) * 100);
    const filled = Math.round((width * current) / total);
    const bar = '█'.repeat(filled) + '░'.repeat(width - filled);
    return `[${bar}] ${percent}%`;
}

async function processInputDirectory(): Promise<void> {
    if (!INPUT_PATH) return;

    let files: Array<{ fullPath: string; relativePath: string }>;
    try {
        files = await findAllFiles(INPUT_PATH);
        files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    } catch (err) {
        log(`✗ Failed to read INPUT_PATH: ${(err as Error).message}`);
        return;
    }

    if (files.length === 0) {
        log(`ℹ  No code files found in ${INPUT_PATH}`);
        return;
    }

    let manifest = await loadManifest(INPUT_PATH);
    if (!manifest) {
        manifest = createManifest(INPUT_PATH, VAULT_PATH);
        log(`\n💡 No manifest found. Will analyze ALL ${files.length} files to build initial index.\n`);
    }

    console.log(`\n🔍 Analyzing ${files.length} code files...\n`);

    let succeeded = 0;
    let failed = 0;
    let skipped = 0;

    for (let i = 0; i < files.length; i++) {
        const { fullPath: filePath, relativePath } = files[i];
        const counter = `[${i + 1}/${files.length}]`;
        const progressBar = buildProgressBar(i + 1, files.length);

        try {
            const changed = await hasFileChanged(filePath, relativePath, manifest);

            if (!changed) {
                console.log(`  ${counter} ${progressBar} ${relativePath}... ⊘ (unchanged)`);
                await updateManifestEntry(manifest, filePath, relativePath, 'skipped');
                skipped++;
            } else {
                process.stdout.write(`  ${counter} ${progressBar} ${relativePath}... `);

                const analyzer = makeAnalyzer();
                await analyzer.analyzeFile(filePath, relativePath, files);
                succeeded++;
                await updateManifestEntry(manifest, filePath, relativePath, 'success');
                console.log('✓');
            }
        } catch (err) {
            console.log(`✗ ${(err as Error).message}`);
            failed++;
            await updateManifestEntry(manifest, filePath, relativePath, 'failed');
        }

        console.log('');
    }

    await saveManifest(INPUT_PATH, manifest);
    console.log(generateReport(manifest));
}

async function main(): Promise<void> {
    validate();
    log(`Vault:    ${VAULT_PATH}`);
    log(`Mode:     ${INPUT_PATH ? 'Process INPUT_PATH once' : 'Watch vault/incoming/'}`);
    if (INPUT_PATH) log(`Input:    ${INPUT_PATH}`);
    log(`Provider: ${process.env.CURATOR_PROVIDER ?? 'deepseek'}`);
    log(`Model:    ${process.env.CURATOR_MODEL ?? 'deepseek-reasoner'}`);

    await processInputDirectory();
    process.exit(0);
}

main().catch(err => {
    console.error(`[codex-watcher] Fatal: ${(err as Error).message}`);
    process.exit(1);
});
