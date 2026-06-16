import { ObsidianRAGProvider } from '@backendkit-labs/agent-enterprise';
import { TransformersEmbedder } from './transformers-embedder.js';
import * as path from 'node:path';
import * as os from 'node:os';

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
            embedder: new TransformersEmbedder(
                process.env.CODEX_EMBED_MODEL ?? 'Xenova/nomic-embed-text-v1'
            ),
            topK: 5,
            minScore: 0.1,
        });
    }

    private getIndexPath(): string {
        return path.join(os.homedir(), '.codex-context', 'rag', `${path.basename(this.vaultPath)}.json`);
    }

    async indexVault(): Promise<{ indexed: number; updated: number }> {
        try {
            const result = await this.rag.index({ verbose: false });
            this.isIndexed = true;
            return result;
        } catch (err) {
            throw new Error(`RAG indexing failed: ${(err as Error).message}`);
        }
    }

    async search(query: string, opts: RagSearchOptions = {}): Promise<RagSearchResult[]> {
        if (!this.isIndexed) {
            await this.indexVault();
        }

        try {
            // ObsidianRAGProvider.search() returns a formatted string, not an array.
            // Access the underlying store and embedder directly for structured results.
            const rag = this.rag as any;
            const queryEmbedding = await rag.embedder.embedOne(query);
            const topK = opts.topK ?? 5;
            const minScore = opts.minScore ?? 0.1;
            const rawResults: { chunk: any; score: number }[] = rag.store.search(queryEmbedding, topK);

            return rawResults
                .filter(r => r.score >= minScore)
                .map(({ chunk, score }) => ({
                    title: chunk.title || 'Untitled',
                    content: chunk.text || '',
                    relevance: score,
                    sourcePath: chunk.filePath || '',
                    sourceRef: chunk.metadata?.sourceRef || undefined,
                }));
        } catch (err) {
            throw new Error(`RAG search failed: ${(err as Error).message}`);
        }
    }

    async reload(): Promise<{ indexed: number; updated: number }> {
        this.isIndexed = false;
        return await this.indexVault();
    }

    async getStats(): Promise<{ indexed: boolean; vaultPath: string; indexPath: string }> {
        return {
            indexed: this.isIndexed,
            vaultPath: this.vaultPath,
            indexPath: this.getIndexPath(),
        };
    }
}
