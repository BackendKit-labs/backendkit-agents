import * as fs from 'node:fs/promises';
import * as crypto from 'node:crypto';
import * as path from 'node:path';

export interface FileChecksum {
    filename: string;
    hash: string;
    size: number;
    modified: string;
}

export interface CuratorManifest {
    version: '1.0';
    created: string;
    lastUpdated: string;
    inputPath: string;
    outputPath: string;
    files: Record<string, {
        hash: string;
        size: number;
        modified: string;
        curatedAt: string;
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
export async function loadManifest(inputPath: string): Promise<CuratorManifest | null> {
    const manifestPath = path.join(inputPath, '.curator-manifest.json');
    try {
        const content = await fs.readFile(manifestPath, 'utf-8');
        return JSON.parse(content);
    } catch {
        return null; // Manifest doesn't exist yet
    }
}

/**
 * Save manifest to INPUT_PATH
 */
export async function saveManifest(
    inputPath: string,
    manifest: CuratorManifest
): Promise<void> {
    const manifestPath = path.join(inputPath, '.curator-manifest.json');
    manifest.lastUpdated = new Date().toISOString();
    await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
}

/**
 * Check if file changed since last curation
 */
export async function hasFileChanged(
    filePath: string,
    manifest: CuratorManifest | null
): Promise<boolean> {
    if (!manifest) return true; // First run, all files are "new"

    const filename = path.basename(filePath);
    const entry = manifest.files[filename];
    if (!entry) return true; // Not in manifest, treat as new

    const currentHash = await calculateFileHash(filePath);
    return currentHash !== entry.hash;
}

/**
 * Create initial manifest
 */
export function createManifest(
    inputPath: string,
    outputPath: string
): CuratorManifest {
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
 * Update manifest with file processing result
 */
export async function updateManifestEntry(
    manifest: CuratorManifest,
    filePath: string,
    status: 'success' | 'failed' | 'skipped'
): Promise<void> {
    const filename = path.basename(filePath);
    const stat = await fs.stat(filePath);
    const hash = await calculateFileHash(filePath);

    manifest.files[filename] = {
        hash,
        size: stat.size,
        modified: new Date(stat.mtime).toISOString(),
        curatedAt: new Date().toISOString(),
        status,
    };
}

/**
 * Generate curation report
 */
export function generateReport(manifest: CuratorManifest): string {
    const entries = Object.values(manifest.files);
    const succeeded = entries.filter(e => e.status === 'success').length;
    const failed = entries.filter(e => e.status === 'failed').length;
    const skipped = entries.filter(e => e.status === 'skipped').length;

    return `
📊 Curation Report
───────────────────
Total Files:   ${entries.length}
✓ Succeeded:   ${succeeded}
✗ Failed:      ${failed}
⊘ Skipped:     ${skipped}
Processed:     ${succeeded + failed} / ${entries.length}
Efficiency:    ${skipped > 0 ? `${Math.round((skipped / entries.length) * 100)}% of files unchanged` : 'All files processed'}

Last Updated: ${new Date(manifest.lastUpdated).toLocaleString()}
`;
}
