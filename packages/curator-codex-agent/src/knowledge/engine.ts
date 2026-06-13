/**
 * Knowledge Engine
 * Orchestrates RAG search, synthesis, and vault indexing
 */

import { CuratorRagProvider, type RagSearchResult } from './rag-provider.js';
import { KnowledgeSynthesizer } from './synthesis.js';
import type { CuratorLLMProvider } from '../providers/types.js';

export interface SearchResponse {
    query: string;
    results: RagSearchResult[];
    synthesized?: {
        title: string;
        content: string;
        basedOn: string[];
    };
    totalResults: number;
    durationMs: number;
}

export interface ReloadResponse {
    indexed: number;
    updated: number;
    durationMs: number;
}

export class KnowledgeEngine {
    private rag: CuratorRagProvider;
    private synthesizer: KnowledgeSynthesizer;
    private isInitialized: boolean = false;

    constructor(provider: CuratorLLMProvider, vaultPath: string) {
        this.rag = new CuratorRagProvider(vaultPath);
        this.synthesizer = new KnowledgeSynthesizer(provider, vaultPath);
    }

    /**
     * Initialize the knowledge engine
     */
    async initialize(): Promise<void> {
        try {
            await this.rag.indexVault();
            this.isInitialized = true;
        } catch (err) {
            console.error('Knowledge engine initialization failed:', err);
            throw err;
        }
    }

    /**
     * Search the vault
     */
    async search(query: string, opts: { topK?: number; autoSynthesize?: boolean } = {}): Promise<SearchResponse> {
        const start = Date.now();

        if (!this.isInitialized) {
            await this.initialize();
        }

        try {
            const results = await this.rag.search(query, { topK: opts.topK || 5 });

            let synthesized: any = undefined;
            if (opts.autoSynthesize !== false && results.length > 0) {
                const synthesis = await this.synthesizer.synthesize(query, results);
                if (synthesis) {
                    const saved = await this.synthesizer.saveNote(synthesis);
                    if (saved) {
                        synthesized = {
                            title: synthesis.title,
                            content: synthesis.content.slice(0, 500), // Preview
                            basedOn: synthesis.basedOn,
                        };
                    }
                }
            }

            return {
                query,
                results,
                synthesized,
                totalResults: results.length,
                durationMs: Date.now() - start,
            };
        } catch (err) {
            console.error('Search failed:', err);
            throw err;
        }
    }

    /**
     * Reload and reindex the vault
     */
    async reload(): Promise<ReloadResponse> {
        const start = Date.now();

        try {
            const result = await this.rag.reload();
            this.isInitialized = true;

            return {
                indexed: result.indexed,
                updated: result.updated,
                durationMs: Date.now() - start,
            };
        } catch (err) {
            console.error('Reload failed:', err);
            throw err;
        }
    }

    /**
     * Get engine statistics
     */
    async getStats(): Promise<{
        initialized: boolean;
        vaultStats: any;
    }> {
        return {
            initialized: this.isInitialized,
            vaultStats: await this.rag.getStats(),
        };
    }

    /**
     * Create MCP tools for knowledge operations
     */
    createTools() {
        return [
            {
                name: 'knowledge_search',
                description:
                    'Search the vault using semantic search (RAG). Returns relevant notes and optionally generates a synthetic summary note.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: {
                            type: 'string',
                            description: 'Search query (natural language, e.g., "How to handle errors?")',
                        },
                        topK: {
                            type: 'number',
                            description: 'Number of results to return (default: 5)',
                        },
                        autoSynthesize: {
                            type: 'boolean',
                            description: 'Automatically generate a synthesis note (default: true)',
                        },
                    },
                    required: ['query'],
                },
                handler: async (args: any) => {
                    try {
                        const response = await this.search(args.query, {
                            topK: args.topK,
                            autoSynthesize: args.autoSynthesize !== false,
                        });
                        return JSON.stringify(response);
                    } catch (err) {
                        return JSON.stringify({
                            error: (err as Error).message,
                        });
                    }
                },
            },
            {
                name: 'knowledge_reload',
                description: 'Reload and reindex the vault. Call this after external changes to the vault.',
                inputSchema: {
                    type: 'object',
                    properties: {},
                    required: [],
                },
                handler: async () => {
                    try {
                        const response = await this.reload();
                        return JSON.stringify(response);
                    } catch (err) {
                        return JSON.stringify({
                            error: (err as Error).message,
                        });
                    }
                },
            },
            {
                name: 'knowledge_stats',
                description: 'Get knowledge engine statistics.',
                inputSchema: {
                    type: 'object',
                    properties: {},
                    required: [],
                },
                handler: async () => {
                    try {
                        const stats = await this.getStats();
                        return JSON.stringify(stats);
                    } catch (err) {
                        return JSON.stringify({
                            error: (err as Error).message,
                        });
                    }
                },
            },
        ];
    }
}
