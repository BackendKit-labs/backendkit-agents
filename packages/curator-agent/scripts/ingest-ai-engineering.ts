/**
 * Batch ingestion — AI Engineering from Scratch
 *
 * Processes all lesson files from the ai-engineering-from-scratch-public
 * course and writes structured knowledge notes into the AI vault.
 *
 * Skips: autoevaluacion, README, index and web files.
 *
 * Run:
 *   CURATOR_API_KEY=sk-... npm run ingest-ai
 *
 * Optional env vars:
 *   CURATOR_PROVIDER   default: deepseek
 *   CURATOR_MODEL      default: deepseek-chat  (use deepseek-reasoner for higher quality)
 *   AI_DOCS_PATH       default: C:\workspace\ai-engineering-from-scratch-public
 *   AI_VAULT_PATH      default: C:\Users\mairon.cuello\development\workspace-ia\ai-vault
 */

import * as fs   from 'node:fs/promises';
import * as path from 'node:path';
import { KnowledgeCurator } from '../src/curator.js';
import { createProvider }   from '../src/providers/index.js';

// ── Config ────────────────────────────────────────────────────────────────────

const DOCS_PATH  = process.env.AI_DOCS_PATH  ?? 'C:/workspace/ai-engineering-from-scratch-public';
const VAULT_PATH = process.env.AI_VAULT_PATH ?? 'C:/Users/mairon.cuello/development/workspace-ia/ai-vault';

const AREA_BY_MODULE: Record<string, string> = {
    'modulo-0-fundamentos':      'general',
    'modulo-1-machine-learning': 'general',
    'modulo-2-deep-learning':    'general',
    'modulo-3-vision':           'general',
    'modulo-4-nlp-transformers': 'general',
    'modulo-5-generative-ai':    'general',
    'modulo-6-llm-prompt':       'general',
    'modulo-7-agentes':          'general',
    'modulo-8-produccion':       'operaciones',
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function shouldSkip(filePath: string): boolean {
    const name = path.basename(filePath);
    return (
        name.includes('autoevaluacion') ||
        name === 'README.md'            ||
        name === 'guia-de-estudio.md'   ||
        name === 'indice-general.md'    ||
        filePath.includes('/web/')
    );
}

async function collectFiles(): Promise<{ filePath: string; areaHint: string }[]> {
    const result: { filePath: string; areaHint: string }[] = [];
    const entries = await fs.readdir(DOCS_PATH, { withFileTypes: true });

    for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith('modulo-')) {
            const moduleDir  = path.join(DOCS_PATH, entry.name);
            const areaHint   = AREA_BY_MODULE[entry.name] ?? 'general';
            const lessons    = await fs.readdir(moduleDir);

            for (const lesson of lessons.filter(f => f.endsWith('.md'))) {
                const filePath = path.join(moduleDir, lesson);
                if (!shouldSkip(filePath)) {
                    result.push({ filePath, areaHint });
                }
            }
        } else if (entry.isFile() && entry.name === 'recursos-complementarios.md') {
            result.push({
                filePath: path.join(DOCS_PATH, entry.name),
                areaHint: 'general',
            });
        }
    }

    return result.sort((a, b) => a.filePath.localeCompare(b.filePath));
}

function bar(done: number, total: number, width = 30): string {
    const filled = Math.round((done / total) * width);
    return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}] ${done}/${total}`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    if (!process.env.CURATOR_API_KEY) {
        console.error('✗  CURATOR_API_KEY is required');
        process.exit(1);
    }

    const provider = process.env.CURATOR_PROVIDER ?? 'deepseek';
    const model    = process.env.CURATOR_MODEL    ?? 'deepseek-chat';

    console.log('\n  AI Engineering Vault — Batch Ingestion');
    console.log('  ─────────────────────────────────────────────');
    console.log(`  Docs:     ${DOCS_PATH}`);
    console.log(`  Vault:    ${VAULT_PATH}`);
    console.log(`  Provider: ${provider}  Model: ${model}`);
    console.log(`  Tip: set CURATOR_MODEL=deepseek-reasoner for higher extraction quality\n`);

    const curator = new KnowledgeCurator({
        provider: createProvider({ provider: provider as any, model }),
        vaultPath: VAULT_PATH,
    });

    const files = await collectFiles();
    console.log(`  Found ${files.length} lesson files to process\n`);

    let totalWritten  = 0;
    let totalSkipped  = 0;
    let totalErrors   = 0;
    let filesOk       = 0;
    let filesFailed   = 0;

    for (let i = 0; i < files.length; i++) {
        const { filePath, areaHint } = files[i];
        const name = path.relative(DOCS_PATH, filePath);

        process.stdout.write(`  ${bar(i, files.length)}  ${name.slice(0, 50).padEnd(50)}\r`);

        let text: string;
        try {
            text = await fs.readFile(filePath, 'utf-8');
        } catch {
            console.log(`\n  ✗ Cannot read: ${name}`);
            filesFailed++;
            continue;
        }

        const result = await curator.curateText(text, path.basename(filePath), areaHint);

        totalWritten += result.notesWritten.length;
        totalSkipped += result.notesSkipped.length;
        totalErrors  += result.errors.length;

        if (result.errors.length && !result.notesWritten.length) {
            filesFailed++;
            console.log(`\n  ✗ ${name}`);
            result.errors.forEach(e => console.log(`    ${e}`));
        } else {
            filesOk++;
            const notes = result.notesWritten.map(p => path.basename(p)).join(', ');
            if (result.notesWritten.length) {
                process.stdout.write(`\n  ✓ ${name.padEnd(55)} +${result.notesWritten.length} note(s)\n`);
                if (notes) console.log(`    → ${notes}`);
            }
        }
    }

    // Final progress bar
    process.stdout.write(`  ${bar(files.length, files.length)}  done${' '.repeat(46)}\n`);

    console.log('\n  ═══════════════════════════════════════════════');
    console.log('  INGESTION COMPLETE');
    console.log('  ───────────────────────────────────────────────');
    console.log(`  Files processed:  ${filesOk} ok  /  ${filesFailed} failed`);
    console.log(`  Notes written:    ${totalWritten}`);
    console.log(`  Notes skipped:    ${totalSkipped}  (already existed)`);
    if (totalErrors) console.log(`  Errors:           ${totalErrors}`);
    console.log(`\n  Vault ready at: ${VAULT_PATH}\n`);
}

main().catch(err => {
    console.error('\nFatal:', err.message);
    process.exit(1);
});
