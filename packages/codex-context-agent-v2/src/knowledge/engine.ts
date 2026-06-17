import { CuratorRagProvider, type RagSearchResult } from './rag-provider.js';
import { KnowledgeSynthesizer } from './synthesis.js';
import type { CuratorLLMProvider } from '../providers/types.js';
import type { EmbedderProgress } from './transformers-embedder.js';

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

    async initialize(): Promise<void> {
        await this.rag.indexVault();
        this.isInitialized = true;
    }

    async search(
        query: string,
        opts: { topK?: number; autoSynthesize?: boolean } = {}
    ): Promise<SearchResponse> {
        const start = Date.now();

        if (!this.isInitialized) {
            await this.initialize();
        }

        const results = await this.rag.search(query, { topK: opts.topK || 5 });

        let synthesized: SearchResponse['synthesized'] = undefined;
        if (opts.autoSynthesize !== false && results.length > 0) {
            const synthesis = await this.synthesizer.synthesize(query, results);
            if (synthesis) {
                const saved = await this.synthesizer.saveNote(synthesis);
                if (saved) {
                    synthesized = {
                        title: synthesis.title,
                        content: synthesis.content.slice(0, 500),
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
    }

    async reload(): Promise<ReloadResponse> {
        const start = Date.now();
        const result = await this.rag.reload();
        this.isInitialized = true;
        return { indexed: result.indexed, updated: result.updated, durationMs: Date.now() - start };
    }

    async initEmbedder(onProgress?: (info: EmbedderProgress) => void): Promise<{ alreadyCached: boolean }> {
        return this.rag.initEmbedder(onProgress);
    }

    async getStats(): Promise<{ initialized: boolean; vaultStats: any }> {
        return {
            initialized: this.isInitialized,
            vaultStats: await this.rag.getStats(),
        };
    }
}
