import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createRequire } from 'node:module';

// pdf-parse is CJS — use createRequire to load it safely in ESM/NodeNext
const require = createRequire(import.meta.url);

export interface PdfContent {
    text: string;
    pages: number;
    filename: string;
}

/**
 * Extract plain text from a PDF file.
 * Returns the full text content, page count, and filename.
 */
export async function extractPdfText(filePath: string): Promise<PdfContent> {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pdfParse = require('pdf-parse') as (buf: Buffer, opts?: object) => Promise<{ text: string; numpages: number }>;

    const buffer = await fs.readFile(filePath);
    const data = await pdfParse(buffer);

    return {
        text: data.text.trim(),
        pages: data.numpages,
        filename: path.basename(filePath),
    };
}
