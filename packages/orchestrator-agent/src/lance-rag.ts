import * as fs      from 'node:fs';
import * as path    from 'node:path';
import * as lancedb from '@lancedb/lancedb';

// Structural type — SimpleEmbedder and OllamaEmbedder from agent-enterprise both satisfy this.
type AnyEmbedder = { embedOne(text: string): Promise<number[]> };

type ChunkRow = {
    vector:   number[];
    text:     string;
    filePath: string;   // relative to vaultPath, forward-slash separators
    mtime:    number;   // epoch ms — change detection
    chunkId:  string;   // "{filePath}#{chunkIdx}"
};

const CHUNK_MAX = 800;
const CHUNK_MIN = 40;

export class LanceRAGProvider {
    private db:    lancedb.Connection | null = null;
    private table: lancedb.Table | null      = null;

    constructor(private readonly opts: {
        vaultPath: string;
        dbPath:    string;
        embedder:  AnyEmbedder;
        topK:      number;
        minScore:  number;   // cosine similarity threshold [0, 1]
    }) {}

    /**
     * Incrementally indexes the vault — only files with changed mtime are re-embedded.
     * On first run: creates the LanceDB table.
     * On subsequent runs: upserts changed files, prunes deleted files.
     */
    async index(opts?: { verbose?: boolean }): Promise<void> {
        const log = opts?.verbose
            ? (s: string) => process.stderr.write(`[rag] ${s}\n`)
            : () => {};

        fs.mkdirSync(this.opts.dbPath, { recursive: true });

        this.db = await lancedb.connect(this.opts.dbPath);
        const tableNames  = await this.db.tableNames();
        const tableExists = tableNames.includes('chunks');

        // Load existing filePath→mtime map for incremental check
        const existingMtimes = new Map<string, number>();
        if (tableExists) {
            try {
                this.table = await this.db.openTable('chunks');
                const rows = await this.table.query().select(['filePath', 'mtime']).toArray();
                for (const row of rows) {
                    existingMtimes.set(String(row['filePath']), Number(row['mtime']));
                }
            } catch { this.table = null; }
        }

        // Diff: which files need (re)indexing?
        const mdFiles = walkMarkdown(this.opts.vaultPath);
        const toIndex: Array<{ absPath: string; relPath: string; mtime: number }> = [];

        for (const absPath of mdFiles) {
            const relPath = toRelPath(absPath, this.opts.vaultPath);
            const mtime   = fs.statSync(absPath).mtimeMs;
            if (existingMtimes.get(relPath) !== mtime) {
                toIndex.push({ absPath, relPath, mtime });
            }
        }

        const upToDate = mdFiles.length - toIndex.length;
        log(`${mdFiles.length} files — ${upToDate} up-to-date, ${toIndex.length} to index`);

        if (toIndex.length > 0) {
            // Embed all changed files
            const newRows: ChunkRow[]         = [];
            const changedPaths = new Set(toIndex.map(f => f.relPath));

            for (const { absPath, relPath, mtime } of toIndex) {
                const content = fs.readFileSync(absPath, 'utf-8');
                const chunks  = chunkMarkdown(content);
                for (let i = 0; i < chunks.length; i++) {
                    const vector = await this.opts.embedder.embedOne(chunks[i]);
                    newRows.push({ vector, text: chunks[i], filePath: relPath, mtime, chunkId: `${relPath}#${i}` });
                }
                log(`indexed ${relPath} (${chunks.length} chunks)`);
            }

            if (newRows.length > 0) {
                if (!tableExists || !this.table) {
                    // First run: create table — schema inferred from first row
                    this.table = await this.db.createTable('chunks', newRows);
                } else {
                    // Delete stale chunks for changed files, then add new
                    for (const p of changedPaths) {
                        await this.table.delete(sqlStr('filePath', p));
                    }
                    await this.table.add(newRows);
                }
                log(`Done — ${newRows.length} chunks from ${toIndex.length} files`);
            }
        }

        // Prune chunks for vault files that no longer exist
        if (tableExists && this.table && existingMtimes.size > 0) {
            const currentRelPaths = new Set(mdFiles.map(f => toRelPath(f, this.opts.vaultPath)));
            for (const relPath of existingMtimes.keys()) {
                if (!currentRelPaths.has(relPath)) {
                    try { await this.table.delete(sqlStr('filePath', relPath)); } catch { /* best-effort */ }
                    log(`pruned deleted file: ${relPath}`);
                }
            }
        }
    }

    /**
     * Embeds `query` and performs ANN search in LanceDB.
     * Falls back to '' if the index is empty or not yet built.
     */
    async search(query: string): Promise<string> {
        if (!this.db) {
            if (!fs.existsSync(this.opts.dbPath)) return '';
            this.db = await lancedb.connect(this.opts.dbPath);
        }

        if (!this.table) {
            const names = await this.db.tableNames();
            if (!names.includes('chunks')) return '';
            this.table = await this.db.openTable('chunks');
        }

        const queryVec = await this.opts.embedder.embedOne(query);

        let rows: Record<string, unknown>[] = [];
        try {
            // Cosine distance: _distance ∈ [0, 2], 0 = identical.
            // cosine_sim = 1 - _distance   →   threshold = 1 - minScore
            rows = await this.table
                .search(queryVec)
                .distanceType('cosine')
                .limit(this.opts.topK)
                .select(['text', 'filePath', '_distance'])
                .toArray();
        } catch {
            return '';
        }

        const threshold = 1 - this.opts.minScore;
        const hits = rows.filter(r => Number(r['_distance'] ?? Infinity) <= threshold);

        if (hits.length === 0) return '';

        return hits
            .map(r => `[${path.basename(String(r['filePath']))}]\n${String(r['text'])}`)
            .join('\n\n---\n\n');
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Relative path with forward slashes (SQL-safe, platform-consistent). */
function toRelPath(absPath: string, vaultPath: string): string {
    return path.relative(vaultPath, absPath).replace(/\\/g, '/');
}

/** SQL equality predicate with single-quote escaping. */
function sqlStr(col: string, val: string): string {
    return `${col} = '${val.replace(/'/g, "''")}'`;
}

/** Recursively collects .md files, skipping hidden directories. */
function walkMarkdown(dir: string): string[] {
    const files: string[] = [];
    try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.startsWith('.')) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                files.push(...walkMarkdown(full));
            } else if (entry.name.endsWith('.md')) {
                files.push(full);
            }
        }
    } catch { /* skip unreadable dirs */ }
    return files;
}

/**
 * Splits a markdown document into semantic chunks.
 * Splits on H2+ headings; falls back to paragraph splits for oversized sections.
 */
function chunkMarkdown(content: string): string[] {
    const chunks: string[] = [];

    for (const section of content.split(/^#{2,}\s+/m)) {
        const trimmed = section.trim();
        if (trimmed.length < CHUNK_MIN) continue;

        if (trimmed.length <= CHUNK_MAX) {
            chunks.push(trimmed);
        } else {
            // Oversized section: split on paragraph breaks
            let buf = '';
            for (const para of trimmed.split(/\n{2,}/)) {
                if (buf.length + para.length > CHUNK_MAX && buf.length > 0) {
                    if (buf.trim().length >= CHUNK_MIN) chunks.push(buf.trim());
                    buf = para;
                } else {
                    buf += (buf ? '\n\n' : '') + para;
                }
            }
            if (buf.trim().length >= CHUNK_MIN) chunks.push(buf.trim());
        }
    }

    // Fallback: files with no H2+ headings → fixed-size windows
    if (chunks.length === 0 && content.trim().length >= CHUNK_MIN) {
        for (let i = 0; i < content.length; i += CHUNK_MAX) {
            const c = content.slice(i, i + CHUNK_MAX).trim();
            if (c.length >= CHUNK_MIN) chunks.push(c);
        }
    }

    return chunks;
}
