import * as fs   from 'node:fs/promises';
import * as path from 'node:path';
import OpenAI    from 'openai';
import {
    CuratedNote,
    CurationResponse,
    CurationResponseSchema,
    CurationResult,
} from './types.js';

// ── System prompt ─────────────────────────────────────────────────────────────
//
// Strict JSON-only output with Zod-validated schema.
// Low temperature (0.2) for consistent structure.
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
    /** DeepSeek / OpenAI-compatible API key. */
    apiKey: string;
    /** Absolute path to the shared vault root. */
    vaultPath: string;
    /** Model to use. Default: deepseek-chat */
    model?: string;
    /** Base URL. Default: DeepSeek API. Use http://localhost:11434/v1 for Ollama. */
    baseUrl?: string;
    /** Max chars of document text to send to LLM (safety cap). Default: 12 000 */
    maxInputChars?: number;
}

export class KnowledgeCurator {
    private readonly client: OpenAI;
    private readonly vaultPath: string;
    private readonly model: string;
    private readonly maxInputChars: number;

    constructor(opts: CuratorOptions) {
        this.client = new OpenAI({
            apiKey:  opts.apiKey,
            baseURL: opts.baseUrl ?? 'https://api.deepseek.com',
        });
        this.vaultPath    = opts.vaultPath;
        this.model        = opts.model        ?? 'deepseek-chat';
        this.maxInputChars = opts.maxInputChars ?? 12_000;
    }

    // ── Public API ─────────────────────────────────────────────────────────────

    /**
     * Curate raw text. Calls the LLM, validates the response, writes vault notes.
     * Returns a summary of what was written, skipped, or failed.
     */
    async curateText(text: string, source: string): Promise<CurationResult> {
        const start  = Date.now();
        const result: CurationResult = {
            notesWritten: [], notesSkipped: [], errors: [], durationMs: 0,
        };

        // ── 1. LLM call ────────────────────────────────────────────────────────

        let parsed: CurationResponse;
        try {
            parsed = await this.callLLM(text, source);
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

        // ── 2. Write each note ─────────────────────────────────────────────────

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
     * After processing, moves it to vault/processed/ (or vault/failed/ on error).
     */
    async curateFile(filePath: string): Promise<CurationResult> {
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
        const result = await this.curateText(text, source);

        await this.archiveFile(filePath, result.errors.length > 0 && !result.notesWritten.length);
        return result;
    }

    // ── Private ────────────────────────────────────────────────────────────────

    private async callLLM(text: string, source: string): Promise<CurationResponse> {
        const truncated = text.slice(0, this.maxInputChars);
        const userMsg   = `Source: ${source}\n\nDocument:\n${truncated}`;

        const completion = await this.client.chat.completions.create({
            model:           this.model,
            temperature:     0.2,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: SYSTEM_PROMPT },
                { role: 'user',   content: userMsg },
            ],
        });

        const raw = completion.choices[0]?.message?.content ?? '{}';

        // Validate with Zod — throws ZodError on bad shape
        return CurationResponseSchema.parse(JSON.parse(raw));
    }

    private async writeNote(note: CuratedNote, source: string, date: string): Promise<string | null> {
        const dir      = path.join(this.vaultPath, note.area);
        const slug     = slugify(note.title);
        const filename = `${date}-${slug}.md`;
        const filePath = path.join(dir, filename);

        // Dedup: skip if a file with the same slug already exists
        try {
            await fs.access(filePath);
            return null; // already exists
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
