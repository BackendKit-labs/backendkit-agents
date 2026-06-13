/**
 * CuratorClient — typed MCP client for curator-agent
 *
 * Communicates with the curator MCP server over HTTP (StreamableHTTP transport).
 * Does NOT import CuratorAgent — all communication is via MCP protocol.
 *
 * Usage:
 *   const curator = new CuratorClient('http://localhost:3100');
 *   const result  = await curator.process(text, 'doc.txt', 'general');
 *   const result  = await curator.research('BM25 retrieval for RAG');
 *   const result  = await curator.researchUrl('https://arxiv.org/abs/...');
 */

import { Client }                           from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport }    from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface ProcessResult {
    written:    string[];
    skipped:    string[];
    enriched:   string[];
    errors:     string[];
    durationMs: number;
}

// ── CuratorClient ─────────────────────────────────────────────────────────────

export class CuratorClient {
    private readonly serverUrl: string;

    constructor(serverUrl: string) {
        // Normalise — strip trailing slash
        this.serverUrl = serverUrl.replace(/\/$/, '');
    }

    // ── Public API ─────────────────────────────────────────────────────────────

    async process(text: string, source: string, areaHint?: string): Promise<ProcessResult> {
        return this.call<ProcessResult>('curator_process', {
            text,
            source,
            ...(areaHint ? { area_hint: areaHint } : {}),
        });
    }

    async processFile(filePath: string, areaHint?: string): Promise<ProcessResult> {
        return this.call<ProcessResult>('curator_process_file', {
            file_path: filePath,
            ...(areaHint ? { area_hint: areaHint } : {}),
        });
    }

    async research(topic: string): Promise<ProcessResult> {
        return this.call<ProcessResult>('curator_research', { topic });
    }

    async researchUrl(url: string): Promise<ProcessResult> {
        return this.call<ProcessResult>('curator_research_url', { url });
    }

    async vaultStatus(): Promise<string> {
        const text = await this.callRaw('curator_vault_status', {});
        return text;
    }

    async reload(): Promise<void> {
        await this.callRaw('curator_reload', {});
    }

    // ── Internal ───────────────────────────────────────────────────────────────

    private async call<T>(toolName: string, args: Record<string, unknown>): Promise<T> {
        const text = await this.callRaw(toolName, args);
        try {
            return JSON.parse(text) as T;
        } catch {
            // If the server returns a non-JSON error message, surface it
            return { written: [], skipped: [], enriched: [], errors: [text], durationMs: 0 } as unknown as T;
        }
    }

    private async callRaw(toolName: string, args: Record<string, unknown>): Promise<string> {
        const client    = this.createClient();
        const transport = new StreamableHTTPClientTransport(new URL(`${this.serverUrl}/mcp`));

        try {
            await client.connect(transport);
            const result = await client.callTool({ name: toolName, arguments: args });
            const content = result.content as Array<{ type: string; text?: string }>;
            return content.find(c => c.type === 'text')?.text ?? '';
        } finally {
            await client.close().catch(() => {});
        }
    }

    private createClient(): Client {
        return new Client(
            { name: 'curator-client', version: '1.0.0' },
            { capabilities: {} },
        );
    }
}
