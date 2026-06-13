import OpenAI from 'openai';
import type { LLMProvider, LLMMessage, LLMStreamCallbacks, ToolDefinition } from '@backendkit-labs/agent-core';
import type { ProviderConfig } from './config.js';

// OpenAI-compatible provider — covers DeepSeek, Ollama, and OpenAI.
// DeepSeek: base_url=https://api.deepseek.com
// Ollama:   base_url=http://localhost:11434/v1, api_key=ollama
// OpenAI:   base_url omitted (default)

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function isRetryable(err: unknown): boolean {
    if (err && typeof err === 'object' && 'status' in err) {
        const s = (err as { status: number }).status;
        return s === 429 || s >= 500;
    }
    return false;
}

export class OpenAICompatibleProvider implements LLMProvider {
    private readonly client: OpenAI;
    private readonly model: string;
    private readonly maxRetries: number;
    private readonly temperature: number;

    constructor(cfg: ProviderConfig, maxRetries = 3) {
        this.client = new OpenAI({
            apiKey: cfg.api_key ?? 'no-key',
            baseURL: cfg.base_url,
            maxRetries: 0,
        });
        this.model       = cfg.model;
        this.maxRetries  = maxRetries;
        this.temperature = cfg.model.includes('reasoner') ? 1 : 0;
    }

    async chat(messages: LLMMessage[], tools: ToolDefinition[], callbacks: LLMStreamCallbacks): Promise<void> {
        const oaiTools = tools.map(t => ({
            type: 'function' as const,
            function: { name: t.name, description: t.description, parameters: t.parameters },
        })) as OpenAI.Chat.ChatCompletionTool[];

        let attempt = 0;
        let emitted  = false;

        while (attempt < this.maxRetries) {
            attempt++;
            try {
                await this.stream(messages, oaiTools, {
                    ...callbacks,
                    onChunk: (d) => { emitted = true; callbacks.onChunk?.(d); },
                });
                return;
            } catch (err) {
                if (emitted || !isRetryable(err) || attempt >= this.maxRetries) {
                    callbacks.onError(err instanceof Error ? err : new Error(String(err)));
                    return;
                }
                await sleep(Math.min(1000 * 2 ** attempt, 16_000));
            }
        }
    }

    private async stream(
        messages: LLMMessage[],
        oaiTools: OpenAI.Chat.ChatCompletionTool[],
        callbacks: LLMStreamCallbacks,
    ): Promise<void> {
        const stream = await this.client.chat.completions.create({
            model:          this.model,
            messages:       messages as OpenAI.Chat.ChatCompletionMessageParam[],
            tools:          oaiTools.length ? oaiTools    : undefined,
            tool_choice:    oaiTools.length ? 'auto'      : undefined,
            temperature:    this.temperature,
            stream:         true,
            stream_options: { include_usage: true },
        });

        let content = '';
        const toolBuffers = new Map<number, { id: string; name: string; args: string }>();

        for await (const chunk of stream) {
            if (chunk.usage) callbacks.onMetrics?.(chunk.usage.prompt_tokens, chunk.usage.completion_tokens);
            const delta = chunk.choices[0]?.delta;
            if (!delta) continue;
            if (delta.content) { content += delta.content; callbacks.onChunk?.(delta.content); }
            if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                    if (!toolBuffers.has(tc.index)) toolBuffers.set(tc.index, { id: '', name: '', args: '' });
                    const buf = toolBuffers.get(tc.index)!;
                    if (tc.id)                 buf.id   = tc.id;
                    if (tc.function?.name)      buf.name += tc.function.name;
                    if (tc.function?.arguments) buf.args += tc.function.arguments;
                }
            }
        }

        const toolCalls = [...toolBuffers.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, b]) => ({ id: b.id, type: 'function' as const, function: { name: b.name, arguments: b.args } }));

        for (const tc of toolCalls) callbacks.onToolCall?.(tc.function.name, tc.function.arguments, tc.id);

        callbacks.onDone({
            role:       'assistant',
            content:    content || null,
            tool_calls: toolCalls.length ? toolCalls : undefined,
        });
    }
}

// ── Simple one-shot LLM call (no tools, no streaming, returns full text) ─────

export async function callLLM(
    provider: OpenAICompatibleProvider,
    system: string,
    user: string,
): Promise<string> {
    return new Promise((resolve, reject) => {
        let result = '';
        provider.chat(
            [
                { role: 'system',    content: system },
                { role: 'user',      content: user   },
            ],
            [],
            {
                onChunk:  (d)   => { result += d; },
                onDone:   ()    => { resolve(result); },
                onError:  (err) => { reject(err); },
            },
        );
    });
}
