import OpenAI from 'openai';
import type { CuratorLLMProvider } from './types.js';

export interface OpenAIAdapterOptions {
    apiKey: string;
    model: string;
    baseUrl?: string;
    maxTokens?: number;
}

export class OpenAIAdapter implements CuratorLLMProvider {
    private readonly client: OpenAI;
    private readonly model: string;
    private readonly maxTokens: number;
    private readonly isReasoner: boolean;

    constructor(opts: OpenAIAdapterOptions) {
        this.client = new OpenAI({
            apiKey:  opts.apiKey,
            baseURL: opts.baseUrl ?? 'https://api.deepseek.com/v1',
        });
        this.model     = opts.model;
        this.maxTokens = opts.maxTokens ?? 16384;
        this.isReasoner = /reasoner|^o\d/.test(opts.model);
    }

    async complete(systemPrompt: string, userMessage: string): Promise<string> {
        const completion = await this.client.chat.completions.create({
            model:           this.model,
            max_tokens:      this.maxTokens,
            response_format: { type: 'json_object' },
            ...(this.isReasoner ? {} : { temperature: 0.2 }),
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user',   content: userMessage },
            ],
        });
        return completion.choices[0]?.message?.content ?? '{}';
    }
}
