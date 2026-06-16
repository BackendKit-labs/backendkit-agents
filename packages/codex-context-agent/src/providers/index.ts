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
    anthropic: { model: 'claude-sonnet-4-6' },
};

export function createProvider(cfg: ProviderConfig): CuratorLLMProvider {
    const provider = cfg.provider ?? 'deepseek';
    const model    = cfg.model    ?? DEFAULTS[provider].model;
    const baseUrl  = cfg.baseUrl  ?? DEFAULTS[provider].baseUrl;

    if (!cfg.apiKey) throw new Error('API key is required');

    if (provider === 'anthropic') {
        return new AnthropicAdapter({ apiKey: cfg.apiKey, model, maxTokens: cfg.maxTokens });
    }

    return new OpenAIAdapter({ apiKey: cfg.apiKey, model, baseUrl, maxTokens: cfg.maxTokens });
}
