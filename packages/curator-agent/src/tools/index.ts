import * as fs   from 'node:fs/promises';
import * as path from 'node:path';
import { defineTool } from '@backendkit-labs/agent-core';
import { z } from 'zod';
import type { VaultMemory, NoteEntry } from '../memory/vault-memory.js';

// ── Tool factory ──────────────────────────────────────────────────────────────
// All tools are bound to a specific VaultMemory instance and vaultPath.

export function createCuratorTools(memory: VaultMemory, vaultPath: string, onNoteWritten?: (entry: NoteEntry) => void) {

    // ── read_vault_index ─────────────────────────────────────────────────────
    const readVaultIndex = defineTool({
        name:        'read_vault_index',
        description: 'Returns a summary of existing notes in the vault indexed by area. Use before deciding where to place a new note.',
        input: z.object({
            area: z.string().optional().describe('Filter by area (e.g. "general", "insights"). Omit to get all areas.'),
        }),
        execute: async ({ area }: { area?: string }) => {
            const notes = area ? memory.getNotesByArea(area) : memory.getNotes();
            if (notes.length === 0) return `No notes found${area ? ` in area "${area}"` : ''}.`;
            const grouped = groupBy(notes, n => n.area);
            const lines: string[] = [`Vault index (${notes.length} notes):`];
            for (const [a, areaNote] of Object.entries(grouped)) {
                lines.push(`\n## ${a} (${areaNote.length} notes)`);
                for (const n of areaNote.slice(0, 10)) {
                    lines.push(`  - ${n.title} [${n.tags.slice(0, 3).join(', ')}]`);
                }
                if (areaNote.length > 10) lines.push(`  ... and ${areaNote.length - 10} more`);
            }
            return lines.join('\n');
        },
    });

    // ── check_duplicate ──────────────────────────────────────────────────────
    const checkDuplicate = defineTool({
        name:        'check_duplicate',
        description: 'Checks if a similar note already exists in the vault using text similarity. Returns matching notes above threshold.',
        input: z.object({
            title:   z.string().describe('Title of the note to check'),
            content: z.string().describe('Content or summary to check for similarity'),
        }),
        execute: async ({ title, content }: { title: string; content: string }) => {
            const similar = memory.findSimilar(title, content);
            if (similar.length === 0) return 'No duplicates found. This note can be safely created.';
            const lines = [`Found ${similar.length} similar note(s):`];
            for (const n of similar.slice(0, 3)) {
                lines.push(`  - "${n.title}" (${n.area}/${n.relPath})`);
                lines.push(`    ${n.resumen.slice(0, 150)}`);
            }
            lines.push('\nConsider: enriching the existing note instead of creating a new one.');
            return lines.join('\n');
        },
    });

    // ── score_quality ────────────────────────────────────────────────────────
    const scoreQuality = defineTool({
        name:        'score_quality',
        description: 'Evaluates the quality of a note: checks for minimum content length, presence of sections, tags, and resumen.',
        input: z.object({
            title:   z.string(),
            resumen: z.string(),
            content: z.string(),
            tags:    z.array(z.string()),
        }),
        execute: async ({ title, resumen, content, tags }: { title: string; resumen: string; content: string; tags: string[] }) => {
            const issues: string[] = [];
            let score = 1.0;

            if (title.length < 10)    { issues.push('Title too short (< 10 chars)');    score -= 0.2; }
            if (resumen.length < 30)  { issues.push('Resumen too short (< 30 chars)');  score -= 0.2; }
            if (content.length < 100) { issues.push('Content too short (< 100 chars)'); score -= 0.3; }
            if (tags.length === 0)    { issues.push('No tags provided');                score -= 0.1; }
            if (!content.includes('##')) { issues.push('No ## sections in content');   score -= 0.1; }
            if (content === resumen)  { issues.push('Content identical to resumen');   score -= 0.2; }

            const finalScore = Math.max(0, score);
            if (finalScore >= 0.7) return `Quality: PASS (score ${finalScore.toFixed(2)}). Note is ready to write.`;
            return [
                `Quality: FAIL (score ${finalScore.toFixed(2)}).`,
                'Issues:',
                ...issues.map(i => `  - ${i}`),
                'Please fix the issues before writing to vault.',
            ].join('\n');
        },
    });

    // ── get_existing_tags ────────────────────────────────────────────────────
    const getExistingTags = defineTool({
        name:        'get_existing_tags',
        description: 'Returns the most-used tags in the vault, optionally filtered by area. Use to ensure new tags follow the existing taxonomy.',
        input: z.object({
            area:     z.string().optional().describe('Filter by area to get area-specific tags'),
            max_tags: z.number().optional().describe('Max tags to return (default 30)'),
        }),
        execute: async ({ area, max_tags = 30 }: { area?: string; max_tags?: number }) => {
            const tags = memory.getAllTags(area).slice(0, max_tags);
            if (tags.length === 0) return 'No tags found in vault yet. You can create new taxonomy.';
            return [
                `Top ${tags.length} tags${area ? ` in "${area}"` : ''} (by frequency):`,
                tags.map(t => `  - ${t}`).join('\n'),
                '\nFollow existing tag format: "area/<area>", "tipo/<type>", "estado/<state>"',
            ].join('\n');
        },
    });

    // ── write_to_vault ───────────────────────────────────────────────────────
    const writeToVault = defineTool({
        name:        'write_to_vault',
        description: 'Writes a curated note as a .md file to the vault. Returns the file path on success.',
        input: z.object({
            area:    z.string().describe('Target subdirectory in vault (e.g. "general", "insights")'),
            title:   z.string().describe('Note title (used in frontmatter and filename)'),
            resumen: z.string().describe('1-2 sentence summary for frontmatter and search'),
            content: z.string().describe('Full markdown body with ## sections'),
            tags:    z.array(z.string()).describe('Hierarchical tags'),
            source:  z.string().describe('Original source filename or reference'),
            tipo:    z.string().optional().describe('Document type: politica | decision | procedimiento | leccion | norma_externa'),
        }),
        execute: async ({ area, title, resumen, content, tags, source, tipo }: {
            area: string; title: string; resumen: string;
            content: string; tags: string[]; source: string; tipo?: string;
        }) => {
            const date     = new Date().toISOString().slice(0, 10);
            const slug     = slugify(title);
            const dir      = path.join(vaultPath, area);
            const filename = `${date}-${slug}.md`;
            const filePath = path.join(dir, filename);

            // Dedup check
            try {
                await fs.access(filePath);
                return `Note already exists at ${filePath}. Skipped to avoid duplicate.`;
            } catch { /* proceed */ }

            const markdown = buildMarkdown({ title, resumen, content, tags, source, area, tipo, date });

            await fs.mkdir(dir, { recursive: true });
            await fs.writeFile(filePath, markdown, 'utf-8');

            // Update memory so next tools see this note
            const entry = {
                filePath,
                relPath: `${area}/${filename}`,
                area, title, tags, resumen, date,
            };
            memory.addNote(entry);
            onNoteWritten?.(entry);

            return `Note written successfully: ${filePath}\nVault status: ${memory.summary()}`;
        },
    });

    // ── notify_vault_manager ─────────────────────────────────────────────────
    const notifyVaultManager = defineTool({
        name:        'notify_vault_manager',
        description: 'Notifies vault-manager to sync the vault after writing new notes. Triggers the /api/vaults/:id/sync endpoint.',
        input: z.object({
            vault_manager_url: z.string().describe('Base URL of vault-manager (e.g. http://localhost:3000)'),
            vault_id:          z.string().describe('ID of the vault definition in vault-manager DB'),
        }),
        execute: async ({ vault_manager_url, vault_id }: { vault_manager_url: string; vault_id: string }) => {
            try {
                const url = `${vault_manager_url.replace(/\/$/, '')}/api/vaults/${vault_id}/sync`;
                const res = await fetch(url, { method: 'POST' });
                if (!res.ok) {
                    const err = await res.text();
                    return `Sync failed (${res.status}): ${err}`;
                }
                const data = await res.json() as { imported: number; skipped: number; total: number };
                return `Vault-manager synced: +${data.imported} imported, ${data.skipped} skipped, ${data.total} total.`;
            } catch (err) {
                return `Could not reach vault-manager: ${(err as Error).message}`;
            }
        },
    });

    return { readVaultIndex, checkDuplicate, scoreQuality, getExistingTags, writeToVault, notifyVaultManager };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(title: string): string {
    return title
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9\s-]/g, '')
        .trim()
        .replace(/\s+/g, '-')
        .slice(0, 60);
}

function buildMarkdown(opts: {
    title: string; resumen: string; content: string; tags: string[];
    source: string; area: string; tipo?: string; date: string;
}): string {
    const tagsLine = `[${opts.tags.map(t => `"${t}"`).join(', ')}]`;
    const lines = [
        '---',
        `title: "${opts.title.replace(/"/g, '\\"')}"`,
        `area: ${opts.area}`,
        opts.tipo ? `tipo: ${opts.tipo}` : null,
        `resumen: "${opts.resumen.replace(/"/g, '\\"')}"`,
        `author: "agent/curator"`,
        `date: ${opts.date}`,
        `source_ref: "${opts.source}"`,
        `tags: ${tagsLine}`,
        '---',
        '',
        opts.content,
    ].filter(l => l !== null);
    return lines.join('\n');
}

function groupBy<T>(items: T[], key: (item: T) => string): Record<string, T[]> {
    const result: Record<string, T[]> = {};
    for (const item of items) {
        const k = key(item);
        (result[k] ??= []).push(item);
    }
    return result;
}
