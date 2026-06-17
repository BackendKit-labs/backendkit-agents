export interface CompleteOptions {
    /**
     * Force structured JSON output (default: true).
     * Set to false for free-form text/markdown responses (e.g. synthesis).
     */
    json?: boolean;
}

export interface CuratorLLMProvider {
    complete(systemPrompt: string, userMessage: string, opts?: CompleteOptions): Promise<string>;
}
