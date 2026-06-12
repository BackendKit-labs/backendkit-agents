import { OpenAIAdapter }    from './openai-adapter.js';
import { AnthropicAdapter } from './anthropic-adapter.js';
import type { CuratorLLMProvider } from './types.js';

export { OpenAIAdapter }    from './openai-adapter.js';
export { AnthropicAdapter } from './anthropic-adapter.js';
export type { CuratorLLMProvider } from './types.js';

export type ProviderName = 'openai' | 'deepseek' | 'ollama' | 'anthropic';

export interface ProviderConfig {
    /**
     * Which provider backend to use.
     *   openai     → OpenAI GPT (o3, o4-mini, gpt-4o)
     *   deepseek   → DeepSeek API (deepseek-reasoner, deepseek-chat)  ← default
     *   ollama     → Local Ollama (llama3.2, qwen2.5-coder, …)
     *   anthropic  → Anthropic Claude (claude-opus-4-8, claude-sonnet-4-6)
     */
    provider?: ProviderName;
    apiKey: string;
    /** Model ID. When omitted, a sensible default is used per provider. */
    model?: string;
    /** Base URL override (openai/deepseek/ollama only). */
    baseUrl?: string;
    maxTokens?: number;
}

const DEFAULTS: Record<ProviderName, { model: string; baseUrl?: string }> = {
    deepseek:  { model: 'deepseek-reasoner', baseUrl: 'https://api.deepseek.com/v1' },
    openai:    { model: 'o3-mini' },
    ollama:    { model: 'qwen2.5-coder:7b',  baseUrl: 'http://localhost:11434/v1' },
    anthropic: { model: 'claude-opus-4-8' },
};

/** Build a CuratorLLMProvider from explicit config or env vars. */
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
