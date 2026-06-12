/** Minimal LLM contract the curator needs — single system+user turn, returns text. */
export interface CuratorLLMProvider {
    complete(systemPrompt: string, userMessage: string): Promise<string>;
}
