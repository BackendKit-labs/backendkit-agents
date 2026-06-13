/**
 * RAG Provider for Curator-Codex
 * Wraps ObsidianRAGProvider with semantic search capabilities
 */

import { ObsidianRAGProvider, SimpleEmbedder } from '@backendkit-labs/agent-enterprise';
import * as path from 'node:path';

export interface RagSearchResult {
    title: string;
    content: string;
    relevance: number;
    sourcePath: string;
    sourceRef?: string;
}

export interface RagSearchOptions {
    topK?: number;
    minScore?: number;
}

export class CuratorRagProvider {
    private rag: ObsidianRAGProvider;
    private vaultPath: string;
    private isIndexed: boolean = false;

    constructor(vaultPath: string) {
        this.vaultPath = vaultPath;
        this.rag = new ObsidianRAGProvider({
            vaultPath,
            indexPath: this.getIndexPath(),
            embedder: new SimpleEmbedder(),
            topK: 5,
            minScore: 0.1,
        });
    }

    private getIndexPath(): string {
        const homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
        return path.join(homeDir, '.curator-codex', 'rag', `${path.basename(this.vaultPath)}.json`);
    }

    /**
     * Index the vault (loads all notes and creates embeddings)
     */
    async indexVault(): Promise<{ indexed: number; updated: number }> {
        try {
            const result = await this.rag.index({ verbose: false });
            this.isIndexed = true;
            return result;
        } catch (err) {
            console.error('Failed to index vault:', err);
            throw new Error(`RAG indexing failed: ${(err as Error).message}`);
        }
    }

    /**
     * Search the vault with semantic search
     */
    async search(query: string, opts: RagSearchOptions = {}): Promise<RagSearchResult[]> {
        if (!this.isIndexed) {
            await this.indexVault();
        }

        try {
            const results = await this.rag.search(query, {
                topK: opts.topK || 5,
                minScore: opts.minScore || 0.1,
            });

            return results.map((r: any) => ({
                title: r.title || 'Untitled',
                content: r.content || r.text || '',
                relevance: r.score || r.relevance || 0,
                sourcePath: r.path || r.source || '',
                sourceRef: r.sourceRef || undefined,
            }));
        } catch (err) {
            console.error('Search failed:', err);
            throw new Error(`RAG search failed: ${(err as Error).message}`);
        }
    }

    /**
     * Reload/reindex the vault
     */
    async reload(): Promise<{ indexed: number; updated: number }> {
        this.isIndexed = false;
        return await this.indexVault();
    }

    /**
     * Get vault statistics
     */
    async getStats(): Promise<{
        indexed: boolean;
        vaultPath: string;
        indexPath: string;
    }> {
        return {
            indexed: this.isIndexed,
            vaultPath: this.vaultPath,
            indexPath: this.getIndexPath(),
        };
    }

    /**
     * Create MCP tool for search
     */
    createSearchTool() {
        return {
            name: 'knowledge_search',
            description: 'Search the vault using semantic search (RAG). Returns relevant notes based on your query.',
            inputSchema: {
                type: 'object',
                properties: {
                    query: {
                        type: 'string',
                        description: 'Search query (natural language)',
                    },
                    topK: {
                        type: 'number',
                        description: 'Number of results to return (default: 5)',
                    },
                },
                required: ['query'],
            },
            handler: async (args: { query: string; topK?: number }) => {
                try {
                    const results = await this.search(args.query, { topK: args.topK });
                    return JSON.stringify({
                        query: args.query,
                        results,
                        count: results.length,
                    });
                } catch (err) {
                    return JSON.stringify({
                        error: (err as Error).message,
                    });
                }
            },
        };
    }

    /**
     * Create MCP tool for reload
     */
    createReloadTool() {
        return {
            name: 'knowledge_reload',
            description: 'Reload and reindex the vault. Call this after external changes to the vault.',
            inputSchema: {
                type: 'object',
                properties: {},
                required: [],
            },
            handler: async () => {
                try {
                    const result = await this.reload();
                    return JSON.stringify({
                        success: true,
                        indexed: result.indexed,
                        updated: result.updated,
                    });
                } catch (err) {
                    return JSON.stringify({
                        error: (err as Error).message,
                    });
                }
            },
        };
    }
}
