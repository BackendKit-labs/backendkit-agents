import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import type { CuratorLLMProvider } from './providers/types.js';
import type { CodeAnalysisNote, CodeAnalysisResult, FileAnalysisContext, AssociatedDocs } from './types.js';
import { DocumentationCurator } from './documentation-curator.js';

const CodeAnalysisNoteSchema = z.object({
    type: z.enum(['componente', 'api', 'patron', 'utilidad', 'arquitectura', 'integracion']),
    area: z.enum(['general', 'backend', 'frontend', 'devops', 'infraestructura']),
    title: z.string().max(120),
    resumen: z.string().max(500),
    content: z.string(),
    tags: z.array(z.string()),
    vigente_desde: z.string().optional(),
    version: z.number().optional(),
    expires_at: z.string().optional(),
    depends_on: z.array(z.string()).optional(),
    exports: z.array(z.string()).optional(),
    language: z.string().optional(),
    files: z.array(z.string()).optional(),
});

const CodeAnalysisResponseSchema = z.object({
    notes: z.array(CodeAnalysisNoteSchema),
});

type CodeAnalysisResponse = z.infer<typeof CodeAnalysisResponseSchema>;

const SYSTEM_PROMPT = `\
You are a Code Knowledge Extractor for enterprise vaults.
Your task: analyze source code files WITH associated documentation and extract structured knowledge.

IMPORTANT: Return ONLY a valid JSON object — no markdown, no prose, no code fences.

Schema (return exactly this shape):
{
  "notes": [
    {
      "type": "componente" | "api" | "patron" | "utilidad" | "arquitectura" | "integracion",
      "area": "general" | "backend" | "frontend" | "devops" | "infraestructura",
      "title": string,
      "resumen": string,
      "content": string,
      "tags": string[],
      "language": string,
      "files": string[],
      "depends_on": string[],
      "exports": string[],
      "version": number
    }
  ]
}

Rules:
- Extract PUBLIC APIs only (not private/internal implementation).
- Include TypeScript interfaces, type definitions, main classes.
- Focus on WHAT the code does, HOW to use it, what it exports.
- Each note must be self-contained — a reader should not need the original code.
- "resumen" must contain searchable terms: function names, types, patterns.
- "content" must use ## headings. Include usage examples from comments or docs.
- "exports" lists public functions, classes, interfaces.
- "depends_on" lists external libraries or internal modules this depends on.
- If code has associated documentation (.md file), integrate it into the analysis.
- If no enterprise relevance, return { "notes": [] }.`;

const CODE_EXTENSIONS = [
    '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.kt', '.swift',
];

function getLanguage(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const langMap: Record<string, string> = {
        '.ts': 'typescript', '.tsx': 'typescript',
        '.js': 'javascript', '.jsx': 'javascript',
        '.py': 'python', '.go': 'go', '.rs': 'rust',
        '.java': 'java', '.c': 'c', '.cpp': 'cpp',
        '.kt': 'kotlin', '.swift': 'swift',
    };
    return langMap[ext] || ext.slice(1);
}

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

function buildFrontmatter(note: CodeAnalysisNote, source: string, date: string, sourcesCombined?: string[]): string {
    const tagsLine = `[${note.tags.map(t => `"${t}"`).join(', ')}]`;
    const lines = [
        '---',
        `title: "${note.title.replace(/"/g, '\\"')}"`,
        `area: ${note.area}`,
        `tipo: ${note.type}`,
        `language: ${note.language || 'unknown'}`,
        `resumen: "${note.resumen.replace(/"/g, '\\"')}"`,
        `author: "agent/codex"`,
        `date: ${date}`,
        `source_ref: "${source}"`,
        `tags: ${tagsLine}`,
    ];

    if (sourcesCombined?.length) {
        lines.push(`sources_combined: [${sourcesCombined.map(s => `"${s}"`).join(', ')}]`);
    }
    if (note.version) lines.push(`version: ${note.version}`);
    if (note.depends_on?.length) {
        lines.push(`depends_on: [${note.depends_on.map(d => `"${d}"`).join(', ')}]`);
    }
    if (note.exports?.length) {
        lines.push(`exports: [${note.exports.map(e => `"${e}"`).join(', ')}]`);
    }
    if (note.files?.length) {
        lines.push(`files: [${note.files.map(f => `"${f}"`).join(', ')}]`);
    }

    lines.push('---', '', note.content);
    return lines.join('\n');
}

export interface CodeAnalyzerOptions {
    provider: CuratorLLMProvider;
    vaultPath: string;
    maxInputChars?: number;
}

export class CodeAnalyzer {
    private readonly provider: CuratorLLMProvider;
    private readonly vaultPath: string;
    private readonly maxInputChars: number;
    private readonly docCurator: DocumentationCurator;

    constructor(opts: CodeAnalyzerOptions) {
        this.provider = opts.provider;
        this.vaultPath = opts.vaultPath;
        this.maxInputChars = opts.maxInputChars ?? 20_000;
        this.docCurator = new DocumentationCurator({ provider: opts.provider, vaultPath: opts.vaultPath });
    }

    async findAssociatedDocs(
        filePath: string,
        allFiles: Array<{ fullPath: string; relativePath: string }>
    ): Promise<AssociatedDocs> {
        const basename = path.basename(filePath, path.extname(filePath));
        const dirname = path.dirname(filePath);
        const result: AssociatedDocs = { codeFile: filePath };

        const mdFile = allFiles.find(f => f.fullPath === path.join(dirname, `${basename}.md`));
        if (mdFile) result.docFile = mdFile.fullPath;

        const readmeFile = allFiles.find(f => f.fullPath === path.join(dirname, 'README.md'));
        if (readmeFile) result.readmeFile = readmeFile.fullPath;

        if (!result.docFile) {
            const docsFile = allFiles.find(f =>
                f.relativePath.includes('docs/') && f.relativePath.includes(basename) && f.relativePath.endsWith('.md')
            );
            if (docsFile) result.docFile = docsFile.fullPath;
        }

        if (!result.contextFile) {
            const globalReadme = allFiles.find(f => f.relativePath === 'README.md');
            if (globalReadme) result.contextFile = globalReadme.fullPath;
        }

        return result;
    }

    async analyzeFile(
        filePath: string,
        relativePath: string,
        allFiles?: Array<{ fullPath: string; relativePath: string }>
    ): Promise<CodeAnalysisResult> {
        if (this.isDocFile(filePath)) {
            return await this.docCurator.curateFile(filePath);
        }
        return await this.analyzeCode(filePath, relativePath, allFiles);
    }

    private isDocFile(filePath: string): boolean {
        return ['.md', '.txt', '.pdf'].some(ext => filePath.toLowerCase().endsWith(ext));
    }

    private async analyzeCode(
        filePath: string,
        relativePath: string,
        allFiles?: Array<{ fullPath: string; relativePath: string }>
    ): Promise<CodeAnalysisResult> {
        const start = Date.now();
        const result: CodeAnalysisResult = {
            notesWritten: [],
            notesSkipped: [],
            errors: [],
            durationMs: 0,
            filesAnalyzed: [relativePath],
        };

        let code: string;
        try {
            code = await fs.readFile(filePath, 'utf-8');
        } catch (err) {
            result.errors.push(`Cannot read file: ${(err as Error).message}`);
            result.durationMs = Date.now() - start;
            return result;
        }

        let context: FileAnalysisContext = {
            fullPath: filePath,
            relativePath,
            language: getLanguage(filePath),
            codeContent: code,
        };

        if (allFiles) {
            const associated = await this.findAssociatedDocs(filePath, allFiles);
            if (associated.docFile) {
                try { context.docContent = await fs.readFile(associated.docFile, 'utf-8'); } catch { /* ignore */ }
            }
            if (associated.contextFile) {
                try { context.contextContent = await fs.readFile(associated.contextFile, 'utf-8'); } catch { /* ignore */ }
            }
            if (associated.readmeFile) {
                try { context.readmeContent = await fs.readFile(associated.readmeFile, 'utf-8'); } catch { /* ignore */ }
            }
        }

        let parsed: CodeAnalysisResponse;
        try {
            parsed = await this.callLLM(context);
        } catch (err) {
            result.errors.push(`LLM call failed: ${(err as Error).message}`);
            result.durationMs = Date.now() - start;
            return result;
        }

        if (!parsed.notes.length) {
            result.errors.push('LLM returned no notes — file may not have enterprise relevance.');
            result.durationMs = Date.now() - start;
            return result;
        }

        const date = new Date().toISOString().slice(0, 10);
        const sourcesCombined = allFiles ? this.getSourcesCombined(filePath, allFiles) : [relativePath];

        for (const note of parsed.notes) {
            try {
                const written = await this.writeNote(note, path.basename(filePath), date, sourcesCombined);
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

    private getSourcesCombined(
        filePath: string,
        allFiles: Array<{ fullPath: string; relativePath: string }>
    ): string[] {
        const basename = path.basename(filePath, path.extname(filePath));
        const dirname = path.dirname(filePath);
        const sources: string[] = [];

        const mainFile = allFiles.find(f => f.fullPath === filePath);
        if (mainFile) sources.push(mainFile.relativePath);

        const docFile = allFiles.find(f => f.fullPath === path.join(dirname, `${basename}.md`));
        if (docFile) sources.push(docFile.relativePath);

        const readmeFile = allFiles.find(f => f.fullPath === path.join(dirname, 'README.md'));
        if (readmeFile) sources.push(readmeFile.relativePath);

        return sources.length > 0 ? sources : [path.basename(filePath)];
    }

    private async callLLM(context: FileAnalysisContext): Promise<CodeAnalysisResponse> {
        const truncated = context.codeContent.slice(0, this.maxInputChars);
        let userMsg = `File: ${context.relativePath}\nLanguage: ${context.language}\n\nCODE:\n\`\`\`\n${truncated}\n\`\`\``;

        if (context.docContent) {
            userMsg += `\n\nAssociated Documentation:\n${context.docContent.slice(0, 5000)}`;
        }
        if (context.readmeContent) {
            userMsg += `\n\nProject Context (README):\n${context.readmeContent.slice(0, 3000)}`;
        }

        const raw = await this.provider.complete(SYSTEM_PROMPT, userMsg);
        const jsonStr = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
        const sanitized = jsonStr.replace(/:\s*undefined/g, ': null');
        const parsed = JSON.parse(sanitized);

        if (Array.isArray(parsed?.notes)) {
            for (const note of parsed.notes) {
                if (typeof note.resumen === 'string' && note.resumen.length > 500) {
                    note.resumen = note.resumen.slice(0, 497) + '…';
                }
                for (const key of ['version', 'depends_on', 'exports', 'language', 'files']) {
                    if (note[key] === null) delete note[key];
                }
            }
        }

        return CodeAnalysisResponseSchema.parse(parsed);
    }

    private async writeNote(
        note: CodeAnalysisNote,
        source: string,
        date: string,
        sourcesCombined?: string[]
    ): Promise<string | null> {
        const dir = path.join(this.vaultPath, note.area);
        const slug = slugify(note.title);
        const filename = `${date}-${slug}.md`;
        const filePath = path.join(dir, filename);

        try {
            await fs.access(filePath);
            return null; // already exists — dedup
        } catch {
            // doesn't exist — proceed
        }

        await fs.mkdir(dir, { recursive: true });
        const content = buildFrontmatter(note, source, date, sourcesCombined);
        await fs.writeFile(filePath, content, 'utf-8');
        return filePath;
    }
}
