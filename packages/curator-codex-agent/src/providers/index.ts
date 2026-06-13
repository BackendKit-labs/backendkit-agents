import { OpenAIAdapter }    from './openai-adapter.js';
import { AnthropicAdapter } from './anthropic-adapter.js';
import type { CuratorLLMProvider } from './types.js';

export { OpenAIAdapter }    from './openai-adapter.js';
export { AnthropicAdapter } from './anthropic-adapter.js';
export type { CuratorLLMProvider } from './types.js';

export type ProviderName = 'openai' | 'deepseek' | 'ollama' | 'anthropic';

export interface ProviderConfig {
    provider?: ProviderName;
    apiKey: string;
    model?: string;
    baseUrl?: string;
    maxTokens?: number;
}

const DEFAULTS: Record<ProviderName, { model: string; baseUrl?: string }> = {
    deepseek:  { model: 'deepseek-reasoner', baseUrl: 'https://api.deepseek.com/v1' },
    openai:    { model: 'o3-mini' },
    ollama:    { model: 'qwen2.5-coder:7b',  baseUrl: 'http://localhost:11434/v1' },
    anthropic: { model: 'claude-opus-4-8' },
};

export function createProvider(cfg?: Partial<ProviderConfig>): CuratorLLMProvider {
    const provider = (cfg?.provider ?? process.env.CURATOR_PROVIDER ?? 'deepseek') as ProviderName;
    const apiKey   = cfg?.apiKey   ?? process.env.CURATOR_API_KEY   ?? '';
    const model    = cfg?.model    ?? process.env.CURATOR_MODEL      ?? DEFAULTS[provider].model;
    const baseUrl  = cfg?.baseUrl  ?? process.env.CURATOR_BASE_URL   ?? DEFAULTS[provider].baseUrl;

    if (!apiKey) throw new Error('CURATOR_API_KEY env var is required');

    if (provider === 'anthropic') {
        return new AnthropicAdapter({ apiKey, model, maxTokens: cfg?.maxTokens });
    }

    return new OpenAIAdapter({ apiKey, model, baseUrl, maxTokens: cfg?.maxTokens });
}
