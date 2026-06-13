export interface CuratorLLMProvider {
    complete(systemPrompt: string, userMessage: string): Promise<string>;
}
