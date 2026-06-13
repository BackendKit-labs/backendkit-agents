/**
 * Curator-Codex API Configuration
 * Manages input/output paths and runtime configuration
 */

export interface ApiConfig {
    inputPath?: string;
    outputPath: string;
    provider: string;
    model: string;
    baseUrl?: string;
    port: number;
}

export class ConfigManager {
    private config: ApiConfig;

    constructor(initialConfig: Partial<ApiConfig> = {}) {
        this.config = {
            inputPath: initialConfig.inputPath || process.env.CURATOR_INPUT_PATH,
            outputPath: initialConfig.outputPath || process.env.CURATOR_OUTPUT_PATH || '',
            provider: initialConfig.provider || process.env.CURATOR_PROVIDER || 'deepseek',
            model: initialConfig.model || process.env.CURATOR_MODEL || 'deepseek-reasoner',
            baseUrl: initialConfig.baseUrl || process.env.CURATOR_BASE_URL,
            port: initialConfig.port || parseInt(process.env.CURATOR_HTTP_PORT || '3100'),
        };

        this.validate();
    }

    private validate(): void {
        if (!this.config.outputPath) {
            throw new Error('CURATOR_OUTPUT_PATH is required');
        }
    }

    getConfig(): ApiConfig {
        return { ...this.config };
    }

    updateConfig(partial: Partial<ApiConfig>): void {
        this.config = { ...this.config, ...partial };
        this.validate();
    }

    setInputPath(path: string): void {
        this.config.inputPath = path;
    }

    setOutputPath(path: string): void {
        this.config.outputPath = path;
        this.validate();
    }

    getInputPath(): string | undefined {
        return this.config.inputPath;
    }

    getOutputPath(): string {
        return this.config.outputPath;
    }
}
