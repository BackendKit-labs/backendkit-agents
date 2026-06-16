import * as path from 'node:path';
import * as os from 'node:os';

// Lazy import — model downloads on first use (~274MB, cached after)
let pipelineFn: typeof import('@xenova/transformers').pipeline | null = null;

async function getPipeline() {
    if (!pipelineFn) {
        const { pipeline, env } = await import('@xenova/transformers');
        env.cacheDir = path.join(os.homedir(), '.cache', 'codex-context', 'models');
        env.allowRemoteModels = true;
        pipelineFn = pipeline;
    }
    return pipelineFn;
}

export class TransformersEmbedder {
    readonly model: string;
    private extractor: any = null;

    constructor(modelId = 'Xenova/nomic-embed-text-v1') {
        this.model = modelId;
    }

    private async getExtractor() {
        if (!this.extractor) {
            const pipeline = await getPipeline();
            this.extractor = await pipeline('feature-extraction', this.model);
        }
        return this.extractor;
    }

    async embed(texts: string[]): Promise<number[][]> {
        if (texts.length === 0) return [];
        const extractor = await this.getExtractor();
        const output = await extractor(texts, { pooling: 'mean', normalize: true });
        return output.tolist() as number[][];
    }

    async embedOne(text: string): Promise<number[]> {
        const results = await this.embed([text]);
        return results[0] ?? [];
    }
}
