import Anthropic from '@anthropic-ai/sdk';
import type { CuratorLLMProvider } from './types.js';

export interface AnthropicAdapterOptions {
    apiKey: string;
    model?: string;
    maxTokens?: number;
}

export class AnthropicAdapter implements CuratorLLMProvider {
    private readonly client: Anthropic;
    private readonly model: string;
    private readonly maxTokens: number;

    constructor(opts: AnthropicAdapterOptions) {
        this.client    = new Anthropic({ apiKey: opts.apiKey });
        this.model     = opts.model     ?? 'claude-opus-4-8';
        this.maxTokens = opts.maxTokens ?? 16384;
    }

    async complete(systemPrompt: string, userMessage: string): Promise<string> {
        const response = await this.client.messages.create({
            model:      this.model,
            max_tokens: this.maxTokens,
            system:     systemPrompt,
            messages:   [{ role: 'user', content: userMessage }],
        });
        const block = response.content[0];
        return block?.type === 'text' ? block.text : '{}';
    }
}
