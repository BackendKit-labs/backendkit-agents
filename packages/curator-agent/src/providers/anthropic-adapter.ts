import Anthropic from '@anthropic-ai/sdk';
import type { CuratorLLMProvider } from './types.js';

export interface AnthropicAdapterOptions {
    apiKey: string;
    /** Claude model ID. Default: claude-opus-4-8 */
    model?: string;
    maxTokens?: number;
}

/**
 * Adapter for Anthropic Claude models (claude-opus-4-8, claude-sonnet-4-6, …).
 * Uses the Anthropic SDK — not OpenAI-compatible.
 */
export class AnthropicAdapter implements CuratorLLMProvider {
    private readonly client: Anthropic;
    private readonly model: string;
    private readonly maxTokens: number;

    constructor(opts: AnthropicAdapterOptions) {
        this.client    = new Anthropic({ apiKey: opts.apiKey });
        this.model     = opts.model     ?? 'claude-opus-4-8';
        this.maxTokens = opts.maxTokens ?? 8192;
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
