import * as fs   from 'node:fs/promises';
import * as path from 'node:path';

export interface NoteEntry {
    filePath: string;
    relPath:  string;
    area:     string;
    title:    string;
    tags:     string[];
    resumen:  string;
    date:     string;
}

/**
 * In-process index of all notes in the vault.
 * Loaded once on startup, updated after every write.
 */
export class VaultMemory {
    private readonly vaultPath: string;
    private notes: NoteEntry[] = [];
    private tagFrequency: Map<string, number> = new Map();

    constructor(vaultPath: string) {
        this.vaultPath = vaultPath;
    }

    async load(): Promise<void> {
        this.notes = [];
        this.tagFrequency = new Map();
        await this.scanDir(this.vaultPath);
    }

    // ── Public API ─────────────────────────────────────────────────────────────

    getNotes(): NoteEntry[] {
        return this.notes;
    }

    getNotesByArea(area: string): NoteEntry[] {
        return this.notes.filter(n => n.area === area);
    }

    getAllTags(area?: string): string[] {
        if (area) {
            const areaTagFreq = new Map<string, number>();
            for (const note of this.notes.filter(n => n.area === area)) {
                for (const tag of note.tags) {
                    areaTagFreq.set(tag, (areaTagFreq.get(tag) ?? 0) + 1);
                }
            }
            return [...areaTagFreq.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([tag]) => tag);
        }
        return [...this.tagFrequency.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([tag]) => tag);
    }

    findSimilar(title: string, content: string, threshold = 0.35): NoteEntry[] {
        const queryWords = tokenize(`${title} ${content}`);
        return this.notes
            .map(note => ({
                note,
                score: jaccard(queryWords, tokenize(`${note.title} ${note.resumen}`)),
            }))
            .filter(({ score }) => score >= threshold)
            .sort((a, b) => b.score - a.score)
            .map(({ note }) => note);
    }

    addNote(entry: NoteEntry): void {
        this.notes.push(entry);
        for (const tag of entry.tags) {
            this.tagFrequency.set(tag, (this.tagFrequency.get(tag) ?? 0) + 1);
        }
    }

    summary(): string {
        const areas = [...new Set(this.notes.map(n => n.area))];
        return [
            `Total notes: ${this.notes.length}`,
            `Areas: ${areas.map(a => `${a} (${this.getNotesByArea(a).length})`).join(', ')}`,
            `Unique tags: ${this.tagFrequency.size}`,
        ].join(' | ');
    }

    // ── Private ────────────────────────────────────────────────────────────────

    private async scanDir(dir: string): Promise<void> {
        let entries: string[];
        try { entries = await fs.readdir(dir); } catch { return; }

        for (const name of entries) {
            if (name.startsWith('.')) continue;
            const full = path.join(dir, name);
            const stat = await fs.stat(full).catch(() => null);
            if (!stat) continue;
            if (stat.isDirectory()) {
                await this.scanDir(full);
            } else if (stat.isFile() && name.endsWith('.md')) {
                const entry = await this.parseNote(full);
                if (entry) {
                    this.notes.push(entry);
                    for (const tag of entry.tags) {
                        this.tagFrequency.set(tag, (this.tagFrequency.get(tag) ?? 0) + 1);
                    }
                }
            }
        }
    }

    private async parseNote(filePath: string): Promise<NoteEntry | null> {
        const rel  = path.relative(this.vaultPath, filePath).replace(/\\/g, '/');
        const area = rel.split('/')[0] ?? 'general';
        let content: string;
        try { content = await fs.readFile(filePath, 'utf-8'); } catch { return null; }

        const fm      = parseFrontmatter(content);
        const title   = fm.title ?? extractH1(content) ?? path.basename(filePath, '.md');
        const tags    = parseTags(fm.tags);
        const resumen = fm.resumen ?? content.replace(/^---[\s\S]*?---\n?/, '').slice(0, 300);
        const date    = fm.date ?? '';

        return { filePath, relPath: rel, area, title, tags, resumen, date };
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseFrontmatter(content: string): Record<string, string> {
    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return {};
    const result: Record<string, string> = {};
    for (const line of match[1]!.split('\n')) {
        const colon = line.indexOf(':');
        if (colon < 0) continue;
        const key = line.slice(0, colon).trim();
        const val = line.slice(colon + 1).trim().replace(/^["']|["']$/g, '');
        result[key] = val;
    }
    return result;
}

function parseTags(raw: string | undefined): string[] {
    if (!raw) return [];
    return raw.replace(/[\[\]]/g, '').split(',').map(t => t.trim()).filter(Boolean);
}

function extractH1(content: string): string | undefined {
    return content.match(/^#\s+(.+)/m)?.[1]?.trim();
}

function tokenize(text: string): Set<string> {
    return new Set(
        text.toLowerCase()
            .replace(/[^a-z0-9áéíóúüñ\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 3),
    );
}

function jaccard(a: Set<string>, b: Set<string>): number {
    if (a.size === 0 && b.size === 0) return 0;
    let intersection = 0;
    for (const w of a) if (b.has(w)) intersection++;
    return intersection / (a.size + b.size - intersection);
}
