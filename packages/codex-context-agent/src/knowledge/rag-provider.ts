import { ObsidianRAGProvider, SimpleEmbedder } from '@backendkit-labs/agent-enterprise';
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
            embedder: new SimpleEmbedder(),
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
            const results = await this.rag.search(query, {
                topK: opts.topK || 5,
                minScore: opts.minScore || 0.1,
            });

            if (!Array.isArray(results)) {
                return [];
            }

            return results.map((r: any) => ({
                title: r.title || 'Untitled',
                content: r.content || r.text || '',
                relevance: r.score || r.relevance || 0,
                sourcePath: r.path || r.source || '',
                sourceRef: r.sourceRef || undefined,
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
