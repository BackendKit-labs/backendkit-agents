import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import type { CuratorLLMProvider } from './providers/types.js';
import type { CodeAnalysisResult } from './types.js';
import { extractPdfText } from './pdf-reader.js';

interface DocumentationNote {
    type: 'politica' | 'decision' | 'procedimiento' | 'leccion' | 'norma_externa';
    area: 'rrhh' | 'finanzas' | 'operaciones' | 'ventas' | 'soporte' | 'legal' | 'calidad' | 'general';
    title: string;
    resumen: string;
    content: string;
    tags: string[];
    vigente_desde?: string;
    version?: number;
    expires_at?: string;
    decidido_por?: string[];
    aplica_a?: string[];
}

const DocumentationNoteSchema = z.object({
    type: z.enum(['politica', 'decision', 'procedimiento', 'leccion', 'norma_externa']),
    area: z.enum(['rrhh', 'finanzas', 'operaciones', 'ventas', 'soporte', 'legal', 'calidad', 'general']),
    title: z.string().max(120),
    resumen: z.string().max(500),
    content: z.string(),
    tags: z.array(z.string()),
    vigente_desde: z.string().optional(),
    version: z.number().optional(),
    expires_at: z.string().optional(),
    decidido_por: z.array(z.string()).optional(),
    aplica_a: z.array(z.string()).optional(),
});

const DocumentationResponseSchema = z.object({
    notes: z.array(DocumentationNoteSchema),
});

type DocumentationResponse = z.infer<typeof DocumentationResponseSchema>;

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
      "title":        string,
      "resumen":      string,
      "content":      string,
      "tags":         string[],
      "vigente_desde": "YYYY-MM-DD" | undefined,
      "version":      number | undefined,
      "expires_at":   "YYYY-MM-DD" | undefined,
      "decidido_por": string[] | undefined,
      "aplica_a":     string[] | undefined
    }
  ]
}

Rules:
- If the document covers multiple areas, create one note per area (max 5 total).
- Each note must be self-contained.
- "resumen" must contain all key searchable terms: amounts, dates, percentages, proper nouns.
- "content" must use ## headings.
- Documents in any language are valid. Output in the same language as the document.
- If the document has no enterprise relevance, return { "notes": [] }.`;

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

function buildFrontmatter(note: DocumentationNote, source: string, date: string): string {
    const tagsLine = `[${note.tags.map(t => `"${t}"`).join(', ')}]`;
    const lines = [
        '---',
        `title: "${note.title.replace(/"/g, '\\"')}"`,
        `area: ${note.area}`,
        `tipo: ${note.type}`,
        `resumen: "${note.resumen.replace(/"/g, '\\"')}"`,
        `author: "agent/codex"`,
        `date: ${date}`,
        `source_ref: "${source}"`,
        `tags: ${tagsLine}`,
    ];
    if (note.vigente_desde) lines.push(`vigente_desde: ${note.vigente_desde}`);
    if (note.version) lines.push(`version: ${note.version}`);
    if (note.expires_at) lines.push(`expires_at: ${note.expires_at}`);
    if (note.decidido_por?.length) {
        lines.push(`decidido_por: [${note.decidido_por.map(d => `"${d}"`).join(', ')}]`);
    }
    if (note.aplica_a?.length) {
        lines.push(`aplica_a: [${note.aplica_a.map(a => `"${a}"`).join(', ')}]`);
    }
    lines.push('---', '', note.content);
    return lines.join('\n');
}

export interface DocumentationCuratorOptions {
    provider: CuratorLLMProvider;
    vaultPath: string;
    maxInputChars?: number;
}

export class DocumentationCurator {
    private readonly provider: CuratorLLMProvider;
    private readonly vaultPath: string;
    private readonly maxInputChars: number;

    constructor(opts: DocumentationCuratorOptions) {
        this.provider = opts.provider;
        this.vaultPath = opts.vaultPath;
        this.maxInputChars = opts.maxInputChars ?? 12_000;
    }

    async curateText(text: string, source: string, areaHint?: string): Promise<CodeAnalysisResult> {
        const start = Date.now();
        const result: CodeAnalysisResult = {
            notesWritten: [],
            notesSkipped: [],
            errors: [],
            durationMs: 0,
        };

        let parsed: DocumentationResponse;
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

    async curateFile(filePath: string, areaHint?: string): Promise<CodeAnalysisResult> {
        const isPdf = filePath.toLowerCase().endsWith('.pdf');

        if (isPdf) {
            try {
                const { text, pages, filename } = await extractPdfText(filePath);
                const source = `${filename} (${pages} pages)`;
                return await this.curateText(text, source, areaHint);
            } catch (err) {
                return {
                    notesWritten: [],
                    notesSkipped: [],
                    errors: [`Cannot extract PDF text: ${(err as Error).message}`],
                    durationMs: 0,
                };
            }
        }

        let text: string;
        try {
            text = await fs.readFile(filePath, 'utf-8');
        } catch (err) {
            return {
                notesWritten: [],
                notesSkipped: [],
                errors: [`Cannot read file: ${(err as Error).message}`],
                durationMs: 0,
            };
        }
        return await this.curateText(text, path.basename(filePath), areaHint);
    }

    private async callLLM(text: string, source: string, areaHint?: string): Promise<DocumentationResponse> {
        const truncated = text.slice(0, this.maxInputChars);
        const hintLine = areaHint ? `\nArea hint: this document is primarily about "${areaHint}".` : '';
        const userMsg = `Source: ${source}${hintLine}\n\nDocument:\n${truncated}`;

        const raw = await this.provider.complete(SYSTEM_PROMPT, userMsg);
        const jsonStr = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
        const sanitized = jsonStr.replace(/:\s*undefined/g, ': null');
        const parsed = JSON.parse(sanitized);

        if (Array.isArray(parsed?.notes)) {
            for (const note of parsed.notes) {
                if (typeof note.resumen === 'string' && note.resumen.length > 500) {
                    note.resumen = note.resumen.slice(0, 497) + '…';
                }
                for (const key of ['vigente_desde', 'version', 'expires_at', 'decidido_por', 'aplica_a']) {
                    if (note[key] === null) delete note[key];
                }
            }
        }

        return DocumentationResponseSchema.parse(parsed);
    }

    private async writeNote(note: DocumentationNote, source: string, date: string): Promise<string | null> {
        const dir = path.join(this.vaultPath, note.area);
        const slug = slugify(note.title);
        const filename = `${date}-${slug}.md`;
        const filePath = path.join(dir, filename);

        try {
            await fs.access(filePath);
            return null;
        } catch {
            // doesn't exist — proceed
        }

        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(filePath, buildFrontmatter(note, source, date), 'utf-8');
        return filePath;
    }
}
