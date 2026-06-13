import * as fs from 'node:fs/promises';
import * as crypto from 'node:crypto';
import * as path from 'node:path';

export interface FileChecksum {
    filename: string;
    hash: string;
    size: number;
    modified: string;
}

export interface CodexManifest {
    version: '1.0';
    created: string;
    lastUpdated: string;
    inputPath: string;
    outputPath: string;
    files: Record<string, {
        relativePath: string;
        hash: string;
        size: number;
        modified: string;
        analyzedAt: string;
        status: 'success' | 'failed' | 'skipped';
    }>;
}

/**
 * Calculate SHA256 hash of a file
 */
export async function calculateFileHash(filePath: string): Promise<string> {
    const content = await fs.readFile(filePath);
    return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Load manifest from INPUT_PATH
 */
export async function loadManifest(inputPath: string): Promise<CodexManifest | null> {
    const manifestPath = path.join(inputPath, '.codex-manifest.json');
    try {
        const content = await fs.readFile(manifestPath, 'utf-8');
        return JSON.parse(content);
    } catch {
        return null;
    }
}

/**
 * Save manifest to INPUT_PATH
 */
export async function saveManifest(
    inputPath: string,
    manifest: CodexManifest
): Promise<void> {
    const manifestPath = path.join(inputPath, '.codex-manifest.json');
    manifest.lastUpdated = new Date().toISOString();
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
}

/**
 * Check if file changed since last analysis
 */
export async function hasFileChanged(
    filePath: string,
    relativePath: string,
    manifest: CodexManifest | null
): Promise<boolean> {
    if (!manifest) return true;
    const entry = manifest.files[relativePath];
    if (!entry) return true;
    const currentHash = await calculateFileHash(filePath);
    return currentHash !== entry.hash;
}

/**
 * Create initial manifest
 */
export function createManifest(
    inputPath: string,
    outputPath: string
): CodexManifest {
    return {
        version: '1.0',
        created: new Date().toISOString(),
        lastUpdated: new Date().toISOString(),
        inputPath,
        outputPath,
        files: {},
    };
}

/**
 * Update manifest with file analysis result
 */
export async function updateManifestEntry(
    manifest: CodexManifest,
    filePath: string,
    relativePath: string,
    status: 'success' | 'failed' | 'skipped'
): Promise<void> {
    const stat = await fs.stat(filePath);
    const hash = await calculateFileHash(filePath);

    manifest.files[relativePath] = {
        relativePath,
        hash,
        size: stat.size,
        modified: new Date(stat.mtime).toISOString(),
        analyzedAt: new Date().toISOString(),
        status,
    };
}

/**
 * Recursively find all code and documentation files
 */
const CODE_EXTENSIONS = [
    '.ts', '.tsx', '.js', '.jsx', '.py', '.go', '.rs', '.java', '.c', '.cpp', '.kt', '.swift',
];

const DOC_EXTENSIONS = ['.md', '.txt'];

export function isCodeFile(filePath: string): boolean {
    return CODE_EXTENSIONS.some(ext => filePath.toLowerCase().endsWith(ext));
}

export function isDocFile(filePath: string): boolean {
    return DOC_EXTENSIONS.some(ext => filePath.toLowerCase().endsWith(ext));
}

export async function findAllFiles(
    dirPath: string,
    relativePath: string = ''
): Promise<Array<{ fullPath: string; relativePath: string }>> {
    const results: Array<{ fullPath: string; relativePath: string }> = [];

    try {
        const entries = await fs.readdir(dirPath, { withFileTypes: true });

        for (const entry of entries) {
            if (entry.name.startsWith('.') ||
                entry.name === 'node_modules' ||
                entry.name === 'dist' ||
                entry.name === 'build' ||
                entry.name === '.git' ||
                entry.name === '.venv' ||
                entry.name === 'venv' ||
                entry.name === '__pycache__') {
                continue;
            }

            const fullPath = path.join(dirPath, entry.name);
            const relPath = relativePath ? path.join(relativePath, entry.name) : entry.name;

            if (entry.isDirectory()) {
                const subResults = await findAllFiles(fullPath, relPath);
                results.push(...subResults);
            } else if (entry.isFile()) {
                const hasCodeExt = isCodeFile(entry.name);
                const hasDocExt = isDocFile(entry.name);
                if (hasCodeExt || hasDocExt) {
                    results.push({ fullPath, relativePath: relPath });
                }
            }
        }
    } catch (err) {
        console.error(`Error reading directory ${dirPath}: ${(err as Error).message}`);
    }

    return results;
}

/**
 * Generate analysis report
 */
export function generateReport(manifest: CodexManifest): string {
    const entries = Object.values(manifest.files);
    const succeeded = entries.filter(e => e.status === 'success').length;
    const failed = entries.filter(e => e.status === 'failed').length;
    const skipped = entries.filter(e => e.status === 'skipped').length;

    return `
📊 Code Analysis Report
───────────────────────
Total Files:   ${entries.length}
✓ Analyzed:    ${succeeded}
✗ Failed:      ${failed}
⊘ Skipped:     ${skipped}
Processed:     ${succeeded + failed} / ${entries.length}
Efficiency:    ${skipped > 0 ? `${Math.round((skipped / entries.length) * 100)}% of files unchanged` : 'All files processed'}

Last Updated: ${new Date(manifest.lastUpdated).toLocaleString()}
`;
}
