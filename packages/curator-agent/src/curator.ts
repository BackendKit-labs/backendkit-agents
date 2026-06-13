import * as fs   from 'node:fs/promises';
import * as path from 'node:path';
import {
    CuratedNote,
    CurationResponse,
    CurationResponseSchema,
    CurationResult,
} from './types.js';
import type { CuratorLLMProvider } from './providers/types.js';

// ── System prompt ─────────────────────────────────────────────────────────────
//
// Strict JSON-only output with Zod-validated schema.
// Temperature 0.2 for non-reasoning models; reasoning models ignore it.
// Max 5 notes per document — forces the LLM to prioritise.

const SYSTEM_PROMPT = `\
You are a Knowledge Curator for an enterprise vault.
Your task: analyze a document and extract structured knowledge notes.

IMPORTANT: Return ONLY a valid JSON object — no markdown, no prose, no code fences.

Schema (return exactly this shape):
{
  "notes": [
    {
      "type":         "politica" | "decision" | "procedimiento" | "leccion" | "norma_externa",
      "area":         "rrhh" | "finanzas" | "operaciones" | "ventas" | "soporte" | "legal" | "calidad" | "general",
      "title":        string,       // Specific and searchable. Max 120 chars.
      "resumen":      string,       // 1-2 sentences DENSE with key terms, numbers, rules, names.
                                    // This drives semantic search — include all searchable facts.
      "content":      string,       // Markdown with ## sections. Extract facts, rules, actions.
                                    // Do NOT copy raw text. Restructure and clarify.
      "tags":         string[],     // e.g. ["área/rrhh", "tipo/politica", "estado/vigente"]
      "vigente_desde": "YYYY-MM-DD" | undefined,   // required for politica
      "version":      number | undefined,
      "expires_at":   "YYYY-MM-DD" | undefined,
      "decidido_por": string[] | undefined,         // required for decision
      "aplica_a":     string[] | undefined
    }
  ]
}

Rules:
- If the document covers multiple areas, create one note per area (max 5 total).
- Each note must be self-contained — a reader should not need the original document.
- "resumen" must contain all key searchable terms: amounts, dates, percentages, proper nouns.
- "content" must use ## headings. No bullet-point-only notes.
- For "politica": include vigente_desde. For "decision": include decidido_por.
- Documents in any language are valid input. Output in the same language as the document.
- If the document has no enterprise relevance, return { "notes": [] } — do not force extraction.`;

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

function buildFrontmatter(note: CuratedNote, source: string, date: string): string {
    const tagsLine = `[${note.tags.map(t => `"${t}"`).join(', ')}]`;
    const lines = [
        '---',
        `title: "${note.title.replace(/"/g, '\\"')}"`,
        `area: ${note.area}`,
        `tipo: ${note.type}`,
        `resumen: "${note.resumen.replace(/"/g, '\\"')}"`,
        `author: "agent/curator"`,
        `date: ${date}`,
        `source_ref: "${source}"`,
        `tags: ${tagsLine}`,
    ];
    if (note.vigente_desde) lines.push(`vigente_desde: ${note.vigente_desde}`);
    if (note.version)       lines.push(`version: ${note.version}`);
    if (note.expires_at)    lines.push(`expires_at: ${note.expires_at}`);
    if (note.decidido_por?.length) {
        lines.push(`decidido_por: [${note.decidido_por.map(d => `"${d}"`).join(', ')}]`);
    }
    if (note.aplica_a?.length) {
        lines.push(`aplica_a: [${note.aplica_a.map(a => `"${a}"`).join(', ')}]`);
    }
    lines.push('---', '', note.content);
    return lines.join('\n');
}

// ── KnowledgeCurator ──────────────────────────────────────────────────────────

export interface CuratorOptions {
    /** LLM provider to use for extraction. Use createProvider() from ./providers/index.ts. */
    provider: CuratorLLMProvider;
    /** Absolute path to the shared vault root. */
    vaultPath: string;
    /** Max chars of document text to send to LLM (safety cap). Default: 12 000 */
    maxInputChars?: number;
}

export class KnowledgeCurator {
    private readonly provider: CuratorLLMProvider;
    private readonly vaultPath: string;
    private readonly maxInputChars: number;

    constructor(opts: CuratorOptions) {
        this.provider      = opts.provider;
        this.vaultPath     = opts.vaultPath;
        this.maxInputChars = opts.maxInputChars ?? 12_000;
    }

    // ── Public API ─────────────────────────────────────────────────────────────

    /**
     * Curate raw text. Calls the LLM, validates the response, writes vault notes.
     *
     * @param areaHint  Optional hint for the primary area ("rrhh", "legal", …).
     *                  Passed to the LLM as context — does not override its judgement.
     */
    async curateText(text: string, source: string, areaHint?: string): Promise<CurationResult> {
        const start  = Date.now();
        const result: CurationResult = {
            notesWritten: [], notesSkipped: [], errors: [], durationMs: 0,
        };

        let parsed: CurationResponse;
        try {
            parsed = await this.callLLM(text, source, areaHint);
        } catch (err) {
            result.errors.push(`LLM call failed: ${(err as Error).message}`);
            result.durationMs = Date.now() - start;
            return result;
        }

        if (!parsed.notes.length) {
            result.errors.push('LLM returned no notes — document may not have enterprise relevance.');
            result.durationMs = Date.now() - start;
            return result;
        }

        const date = new Date().toISOString().slice(0, 10);

        for (const note of parsed.notes) {
            try {
                const written = await this.writeNote(note, source, date);
                if (written === null) {
                    result.notesSkipped.push(note.title);
                } else {
                    result.notesWritten.push(written);
                }
            } catch (err) {
                result.errors.push(`Failed to write "${note.title}": ${(err as Error).message}`);
            }
        }

        result.durationMs = Date.now() - start;
        return result;
    }

    /**
     * Curate a file on disk.
     * @param filePath - Path to the file
     * @param areaHint - Optional area classification hint
     * @param archiveAfter - Whether to move file to processed/failed folder (default: true for watcher mode)
     */
    async curateFile(filePath: string, areaHint?: string, archiveAfter: boolean = true): Promise<CurationResult> {
        let text: string;
        try {
            text = await fs.readFile(filePath, 'utf-8');
        } catch (err) {
            return {
                notesWritten: [], notesSkipped: [],
                errors: [`Cannot read file: ${(err as Error).message}`],
                durationMs: 0,
            };
        }

        const source = path.basename(filePath);
        const result = await this.curateText(text, source, areaHint);

        // Only archive (move) file if archiveAfter is true
        // Set to false for direct INPUT_PATH mode to keep originals untouched
        if (archiveAfter) {
            await this.archiveFile(filePath, result.errors.length > 0 && !result.notesWritten.length);
        }
        return result;
    }

    // ── Private ────────────────────────────────────────────────────────────────

    private async callLLM(text: string, source: string, areaHint?: string): Promise<CurationResponse> {
        const truncated = text.slice(0, this.maxInputChars);
        const hintLine  = areaHint ? `\nArea hint: this document is primarily about "${areaHint}".` : '';
        const userMsg   = `Source: ${source}${hintLine}\n\nDocument:\n${truncated}`;

        const raw = await this.provider.complete(SYSTEM_PROMPT, userMsg);

        // Extract JSON even if the model wrapped it in markdown code fences
        const jsonStr = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();

        // Sanitize: replace JS `undefined` literals (invalid JSON) with null
        const sanitized = jsonStr.replace(/:\s*undefined/g, ': null');
        const parsed    = JSON.parse(sanitized);

        // Normalize notes before Zod validation
        if (Array.isArray(parsed?.notes)) {
            for (const note of parsed.notes) {
                // Truncate resumen if LLM exceeded the limit
                if (typeof note.resumen === 'string' && note.resumen.length > 500) {
                    note.resumen = note.resumen.slice(0, 497) + '…';
                }
                // Drop null optional fields (Zod optional expects undefined, not null)
                for (const key of ['vigente_desde', 'version', 'expires_at', 'decidido_por', 'aplica_a']) {
                    if (note[key] === null) delete note[key];
                }
            }
        }

        return CurationResponseSchema.parse(parsed);
    }

    private async writeNote(note: CuratedNote, source: string, date: string): Promise<string | null> {
        const dir      = path.join(this.vaultPath, note.area);
        const slug     = slugify(note.title);
        const filename = `${date}-${slug}.md`;
        const filePath = path.join(dir, filename);

        try {
            await fs.access(filePath);
            return null; // already exists — dedup
        } catch {
            // doesn't exist — proceed
        }

        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(filePath, buildFrontmatter(note, source, date), 'utf-8');
        return filePath;
    }

    private async archiveFile(filePath: string, failed: boolean): Promise<void> {
        const subdir = failed ? 'failed' : 'processed';
        const dest   = path.join(
            path.dirname(filePath),
            '..',
            subdir,
            path.basename(filePath),
        );
        await fs.mkdir(path.dirname(dest), { recursive: true });
        try { await fs.rename(filePath, dest); } catch { /* ignore if already moved */ }
    }
}
