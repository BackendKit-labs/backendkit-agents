// TODO: Replace with OpenAICompatibleProvider from '@backendkit-labs/agent-coding' once that
// package exports a provider that doesn't pull in the full coding-agent toolset,
// or once @backendkit-labs/agent-core includes a built-in provider. See framework issue #providers.
import OpenAI from 'openai';
import type { LLMProvider, LLMMessage, LLMStreamCallbacks, ToolDefinition } from '@backendkit-labs/agent-core';

export interface OpenAICompatibleProviderOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  maxTokens?: number;
  temperature?: number;
  maxRetries?: number;
}

function isRetryable(err: unknown): boolean {
  if (err && typeof err === 'object' && 'status' in err) {
    const status = (err as { status: number }).status;
    return status === 429 || status >= 500;
  }
  return false;
}

function backoffMs(attempt: number): number {
  return Math.min(1000 * Math.pow(2, attempt), 16_000);
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

export class OpenAICompatibleProvider implements LLMProvider {
  private readonly client: OpenAI;
  private readonly model: string;
  private readonly maxTokens: number;
  private readonly temperature: number;
  private readonly maxRetries: number;

  constructor(opts: OpenAICompatibleProviderOptions) {
    this.client = new OpenAI({ apiKey: opts.apiKey, baseURL: opts.baseUrl, maxRetries: 0 });
    this.model = opts.model;
    this.maxTokens = opts.maxTokens ?? 16384;
    this.temperature = opts.temperature ?? 0.0;
    this.maxRetries = opts.maxRetries ?? 3;
  }

  async chat(messages: LLMMessage[], tools: ToolDefinition[], callbacks: LLMStreamCallbacks): Promise<void> {
    const openaiTools = tools.map(t => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    })) as OpenAI.Chat.ChatCompletionTool[];

    let attempt = 0;
    let contentEmitted = false;

    while (attempt < this.maxRetries) {
      attempt++;
      try {
        await this.stream(messages, openaiTools, {
          ...callbacks,
          onChunk: (delta) => {
            contentEmitted = true;
            callbacks.onChunk?.(delta);
          },
        });
        return;
      } catch (err) {
        if (contentEmitted || !isRetryable(err) || attempt >= this.maxRetries) {
          callbacks.onError(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        await sleep(backoffMs(attempt));
      }
    }
  }

  private async stream(
    messages: LLMMessage[],
    openaiTools: OpenAI.Chat.ChatCompletionTool[],
    callbacks: LLMStreamCallbacks,
  ): Promise<void> {
    const stream = await this.client.chat.completions.create({
      model: this.model,
      messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
      tools: openaiTools.length > 0 ? openaiTools : undefined,
      tool_choice: openaiTools.length > 0 ? 'auto' : undefined,
      max_tokens: this.maxTokens,
      temperature: this.temperature,
      stream: true,
      stream_options: { include_usage: true },
    });

    let contentBuffer = '';
    const toolCallBuffers = new Map<number, { id: string; name: string; args: string }>();

    for await (const chunk of stream) {
      if (chunk.usage) {
        callbacks.onMetrics?.(chunk.usage.prompt_tokens, chunk.usage.completion_tokens);
      }

      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        contentBuffer += delta.content;
        callbacks.onChunk?.(delta.content);
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          if (!toolCallBuffers.has(tc.index)) {
            toolCallBuffers.set(tc.index, { id: tc.id ?? '', name: '', args: '' });
          }
          const buf = toolCallBuffers.get(tc.index)!;
          if (tc.id) buf.id = tc.id;
          if (tc.function?.name) buf.name += tc.function.name;
          if (tc.function?.arguments) buf.args += tc.function.arguments;
        }
      }
    }

    const toolCalls = Array.from(toolCallBuffers.entries())
      .sort(([a], [b]) => a - b)
      .map(([, buf]) => ({
        id: buf.id,
        type: 'function' as const,
        function: { name: buf.name, arguments: buf.args },
      }));

    for (const tc of toolCalls) {
      callbacks.onToolCall?.(tc.function.name, tc.function.arguments, tc.id);
    }

    callbacks.onDone({
      role: 'assistant',
      content: contentBuffer || null,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    });
  }
}
