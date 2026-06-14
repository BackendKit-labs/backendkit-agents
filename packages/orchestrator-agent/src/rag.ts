import * as path from 'node:path';
import * as fs   from 'node:fs';
import {
    ObsidianRAGProvider,
    SimpleEmbedder,
    OllamaEmbedder,
} from '@backendkit-labs/agent-enterprise';
import type { OrchestratorConfig } from './config.js';

export async function buildRAG(
    config:  OrchestratorConfig,
    dataDir: string,
): Promise<{ search: (q: string) => Promise<string> } | null> {
    const vaultCfg = config.orchestrator.vault;
    if (!vaultCfg) return null;

    const indexDir = path.join(dataDir, 'rag');
    fs.mkdirSync(indexDir, { recursive: true });

    const embedder = vaultCfg.embedder === 'ollama'
        ? new OllamaEmbedder({ host: vaultCfg.ollama_host, model: vaultCfg.ollama_model })
        : new SimpleEmbedder();

    const rag = new ObsidianRAGProvider({
        vaultPath: vaultCfg.path,
        indexPath: path.join(indexDir, 'vault.json'),
        embedder,
        topK:      5,
        minScore:  0.1,
    });

    await rag.index({ verbose: false });

    return { search: (query: string) => rag.search(query) };
}
