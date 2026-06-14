import * as path from 'node:path';
import * as fs   from 'node:fs';
import { SimpleEmbedder, OllamaEmbedder } from '@backendkit-labs/agent-enterprise';
import type { OrchestratorConfig }         from './config.js';
import { LanceRAGProvider }                from './lance-rag.js';

export async function buildRAG(
    config:  OrchestratorConfig,
    dataDir: string,
): Promise<{ search: (q: string) => Promise<string> } | null> {
    const vaultCfg = config.orchestrator.vault;
    if (!vaultCfg) return null;

    // LanceDB store: .orchestrator/rag-lance/{chunks.lance/}
    // The old JSON index (.orchestrator/rag/vault.json) is left in place and can be deleted manually.
    const dbPath = path.join(dataDir, 'rag-lance');
    fs.mkdirSync(dbPath, { recursive: true });

    const embedder = vaultCfg.embedder === 'ollama'
        ? new OllamaEmbedder({ host: vaultCfg.ollama_host, model: vaultCfg.ollama_model })
        : new SimpleEmbedder();

    const rag = new LanceRAGProvider({
        vaultPath: vaultCfg.path,
        dbPath,
        embedder,
        topK:      5,
        minScore:  0.1,
    });

    await rag.index({ verbose: false });

    return { search: (query: string) => rag.search(query) };
}
