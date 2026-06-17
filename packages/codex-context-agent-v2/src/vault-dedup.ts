import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Normaliza una ruta de origen a una forma canónica estable:
 * absoluta y con `/` como separador (evita problemas de comparación
 * entre Windows y POSIX, y de escapes YAML al guardarla en frontmatter).
 */
export function normalizeSourcePath(p: string): string {
    return path.resolve(p).replace(/\\/g, '/');
}

/** Extrae el valor de `source_path` del frontmatter de una nota, o null. */
function readSourcePath(content: string): string | null {
    const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fm) return null;
    const m = fm[1].match(/^source_path:\s*"?(.+?)"?\s*$/m);
    return m ? m[1].trim() : null;
}

/**
 * Elimina del vault todas las notas previamente generadas desde el mismo
 * archivo de origen (match por `source_path`). Devuelve cuántas borró.
 *
 * Permite re-curar un archivo sin acumular duplicados cuando el LLM genera
 * un título distinto en cada corrida (el dedup por nombre de archivo fallaba
 * porque el slug del título cambiaba).
 */
export async function removeNotesForSource(vaultPath: string, sourcePath: string): Promise<number> {
    const target = normalizeSourcePath(sourcePath);
    let removed = 0;

    async function walk(dir: string): Promise<void> {
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true, encoding: 'utf8' });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                if (!entry.name.startsWith('.')) await walk(full);
            } else if (entry.isFile() && entry.name.endsWith('.md')) {
                let content: string;
                try {
                    content = await fs.readFile(full, 'utf-8');
                } catch {
                    continue;
                }
                const sp = readSourcePath(content);
                if (sp && normalizeSourcePath(sp) === target) {
                    try {
                        await fs.unlink(full);
                        removed++;
                    } catch {
                        /* ignore */
                    }
                }
            }
        }
    }

    await walk(vaultPath);
    return removed;
}
