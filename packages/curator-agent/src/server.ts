#!/usr/bin/env node
/**
 * curator-agent — MCP stdio server
 *
 * Exposes the KnowledgeCurator as MCP tools so any agent (Claude Code,
 * enterprise agents, etc.) can call curator_ingest_text / curator_ingest_file
 * to inject structured knowledge into the vault.
 *
 * Required env vars:
 *   CURATOR_API_KEY    — DeepSeek / OpenAI-compatible API key
 *   CURATOR_VAULT_PATH — absolute path to the shared vault
 *
 * Optional:
 *   CURATOR_MODEL      — LLM model (default: deepseek-chat)
 *   CURATOR_BASE_URL   — LLM base URL (default: DeepSeek API)
 *
 * Usage in claude_desktop_config.json:
 *   {
 *     "mcpServers": {
 *       "curator": {
 *         "command": "npx",
 *         "args": ["-y", "@backendkit-labs/curator-agent"],
 *         "env": {
 *           "CURATOR_API_KEY": "sk-...",
 *           "CURATOR_VAULT_PATH": "/path/to/vault"
 *         }
 *       }
 *     }
 *   }
 */

import { McpServer }            from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z }                    from 'zod';
import * as fs                  from 'node:fs/promises';
import * as path                from 'node:path';
import { KnowledgeCurator }     from './curator.js';

// ── Bootstrap ─────────────────────────────────────────────────────────────────

function getCurator(vaultOverride?: string): KnowledgeCurator {
    const apiKey    = process.env.CURATOR_API_KEY;
    const vaultPath = vaultOverride ?? process.env.CURATOR_VAULT_PATH;
    if (!apiKey)    throw new Error('CURATOR_API_KEY env var is required');
    if (!vaultPath) throw new Error('CURATOR_VAULT_PATH env var is required (or pass vault_path per tool)');
    return new KnowledgeCurator({
        apiKey,
        vaultPath,
        model:   process.env.CURATOR_MODEL   ?? 'deepseek-chat',
        baseUrl: process.env.CURATOR_BASE_URL,
    });
}

// ── MCP server ────────────────────────────────────────────────────────────────

const srv = new McpServer({ name: 'curator-agent', version: '0.1.0' });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const t = srv.tool.bind(srv) as any;

// ── Tool: curator_ingest_text ─────────────────────────────────────────────────

t(
    'curator_ingest_text',
    'Analyze a document text with a powerful LLM and write structured knowledge notes to the vault. ' +
    'Use this when you receive a document (policy, meeting minutes, regulation, technical doc) ' +
    'that should be indexed and made available to enterprise agents.',
    {
        text: z.string().min(50).describe(
            'Full text of the document to curate (plain text, markdown, or extracted PDF content)',
        ),
        source: z.string().describe(
            'Document origin for audit trail: filename, URL, email subject, etc.',
        ),
        vault_path: z.string().optional().describe(
            'Absolute path to the vault. Falls back to CURATOR_VAULT_PATH env var.',
        ),
    },
    async ({ text, source, vault_path }: { text: string; source: string; vault_path?: string }) => {
        const curator = getCurator(vault_path);
        const result  = await curator.curateText(text, source);
        const lines   = [
            `Curation complete in ${result.durationMs}ms.`,
            result.notesWritten.length
                ? `Written (${result.notesWritten.length}): ${result.notesWritten.map(p => path.basename(p)).join(', ')}`
                : 'No new notes written.',
            result.notesSkipped.length
                ? `Skipped — already exists (${result.notesSkipped.length}): ${result.notesSkipped.join(', ')}`
                : '',
            result.errors.length
                ? `Errors: ${result.errors.join(' | ')}`
                : '',
        ].filter(Boolean);
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
);

// ── Tool: curator_ingest_file ─────────────────────────────────────────────────

t(
    'curator_ingest_file',
    'Read a file from disk, curate its content with a powerful LLM, and write structured notes to the vault. ' +
    'The file is moved to vault/processed/ on success or vault/failed/ on error.',
    {
        file_path: z.string().describe(
            'Absolute path to the file to process. Supports .txt, .md, .csv, or any plain-text format.',
        ),
        vault_path: z.string().optional().describe(
            'Absolute path to the vault. Falls back to CURATOR_VAULT_PATH env var.',
        ),
    },
    async ({ file_path, vault_path }: { file_path: string; vault_path?: string }) => {
        const curator = getCurator(vault_path);
        const result  = await curator.curateFile(file_path);
        const lines   = [
            `File: ${path.basename(file_path)}`,
            `Duration: ${result.durationMs}ms`,
            result.notesWritten.length
                ? `Written: ${result.notesWritten.map(p => path.basename(p)).join(', ')}`
                : 'No new notes written.',
            result.notesSkipped.length
                ? `Skipped (already exists): ${result.notesSkipped.join(', ')}`
                : '',
            result.errors.length
                ? `Errors: ${result.errors.join(' | ')}`
                : '',
        ].filter(Boolean);
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
);

// ── Tool: curator_list_incoming ───────────────────────────────────────────────

t(
    'curator_list_incoming',
    'List files waiting in the vault/incoming/ folder (pending curation).',
    {
        vault_path: z.string().optional().describe(
            'Absolute path to the vault. Falls back to CURATOR_VAULT_PATH env var.',
        ),
    },
    async ({ vault_path }: { vault_path?: string }) => {
        const vp      = vault_path ?? process.env.CURATOR_VAULT_PATH ?? '';
        const dir     = path.join(vp, 'incoming');
        let files: string[];
        try {
            files = await fs.readdir(dir);
        } catch {
            return { content: [{ type: 'text' as const, text: `No incoming/ folder found at ${dir}` }] };
        }
        const filtered = files.filter(f => !f.startsWith('.'));
        const text = filtered.length
            ? `${filtered.length} file(s) pending:\n` + filtered.map(f => `  • ${f}`).join('\n')
            : 'No files pending in incoming/.';
        return { content: [{ type: 'text' as const, text }] };
    },
);

// ── Tool: curator_process_incoming ────────────────────────────────────────────

t(
    'curator_process_incoming',
    'Process all files currently in vault/incoming/. ' +
    'Each file is curated and moved to vault/processed/ or vault/failed/.',
    {
        vault_path: z.string().optional().describe(
            'Absolute path to the vault. Falls back to CURATOR_VAULT_PATH env var.',
        ),
    },
    async ({ vault_path }: { vault_path?: string }) => {
        const vp      = vault_path ?? process.env.CURATOR_VAULT_PATH ?? '';
        const curator = getCurator(vp);
        const dir     = path.join(vp, 'incoming');

        let files: string[];
        try {
            files = (await fs.readdir(dir)).filter(f => !f.startsWith('.'));
        } catch {
            return { content: [{ type: 'text' as const, text: `No incoming/ folder at ${dir}` }] };
        }

        if (!files.length) {
            return { content: [{ type: 'text' as const, text: 'No files to process.' }] };
        }

        const summaries: string[] = [];
        for (const file of files) {
            const filePath = path.join(dir, file);
            const result   = await curator.curateFile(filePath);
            summaries.push(
                `${file}: ${result.notesWritten.length} written, ` +
                `${result.notesSkipped.length} skipped, ` +
                `${result.errors.length} errors (${result.durationMs}ms)`,
            );
        }

        return {
            content: [{
                type: 'text' as const,
                text: `Processed ${files.length} file(s):\n` + summaries.map(s => `  ${s}`).join('\n'),
            }],
        };
    },
);

// ── Start ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const transport = new StdioServerTransport();
    await srv.connect(transport);
    process.stderr.write('[curator-agent] MCP server ready (stdio)\n');
}

main().catch(err => {
    process.stderr.write(`[curator-agent] Fatal: ${(err as Error).message}\n`);
    process.exit(1);
});
