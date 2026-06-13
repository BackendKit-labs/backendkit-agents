/**
 * Curator-Codex API Configuration
 * Manages input/output paths and runtime configuration with workspace support
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

export interface ApiConfig {
    inputPath?: string;
    outputPath: string;
    provider: string;
    model: string;
    baseUrl?: string;
    port: number;
}

export interface Workspace {
    name: string;
    inputPath: string;
    outputPath: string;
    description?: string;
}

export interface WorkspaceConfig {
    workspaces: Workspace[];
    lastUsed: string;
    version: string;
}

export class ConfigManager {
    private config: ApiConfig;
    private workspaces: Map<string, Workspace> = new Map();
    private workspaceConfigPath: string;
    private currentWorkspaceName: string = 'default';

    constructor(initialConfig: Partial<ApiConfig> = {}) {
        // Initialize base config from env vars
        this.config = {
            inputPath: initialConfig.inputPath || process.env.CURATOR_INPUT_PATH,
            outputPath: initialConfig.outputPath || process.env.CURATOR_OUTPUT_PATH || '',
            provider: initialConfig.provider || process.env.CURATOR_PROVIDER || 'deepseek',
            model: initialConfig.model || process.env.CURATOR_MODEL || 'deepseek-reasoner',
            baseUrl: initialConfig.baseUrl || process.env.CURATOR_BASE_URL,
            port: initialConfig.port || parseInt(process.env.CURATOR_HTTP_PORT || '3100'),
        };

        // Setup workspace config path
        const bkAgentDir = process.env.BK_AGENT_DIR ||
            path.join(process.env.HOME || process.env.USERPROFILE || '', '.bk-agent');
        this.workspaceConfigPath = path.join(bkAgentDir, 'curator-workspace.json');

        // Load workspaces if file exists
        this.loadWorkspaces();
        this.validate();
    }

    private loadWorkspaces(): void {
        try {
            if (fs.existsSync(this.workspaceConfigPath)) {
                const content = fs.readFileSync(this.workspaceConfigPath, 'utf-8');
                const wsConfig: WorkspaceConfig = JSON.parse(content);

                wsConfig.workspaces.forEach(ws => {
                    this.workspaces.set(ws.name, ws);
                });

                this.currentWorkspaceName = wsConfig.lastUsed || 'default';
            }
        } catch (err) {
            console.warn(`[ConfigManager] Could not load workspaces: ${(err as Error).message}`);
        }
    }

    private saveWorkspaces(): void {
        try {
            const wsConfig: WorkspaceConfig = {
                workspaces: Array.from(this.workspaces.values()),
                lastUsed: this.currentWorkspaceName,
                version: '1.0.0',
            };
            fs.writeFileSync(this.workspaceConfigPath, JSON.stringify(wsConfig, null, 2), 'utf-8');
        } catch (err) {
            console.warn(`[ConfigManager] Could not save workspaces: ${(err as Error).message}`);
        }
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

    // ── Workspace Methods ────────────────────────────────────────────────────

    switchWorkspace(workspaceName: string): { success: boolean; workspace?: Workspace; error?: string } {
        const workspace = this.workspaces.get(workspaceName);
        if (!workspace) {
            return {
                success: false,
                error: `Workspace "${workspaceName}" not found. Available: ${Array.from(this.workspaces.keys()).join(', ')}`,
            };
        }

        this.currentWorkspaceName = workspaceName;
        this.config.inputPath = workspace.inputPath;
        this.config.outputPath = workspace.outputPath;
        this.saveWorkspaces();

        return { success: true, workspace };
    }

    addWorkspace(workspace: Workspace): void {
        this.workspaces.set(workspace.name, workspace);
        this.saveWorkspaces();
    }

    removeWorkspace(name: string): { success: boolean; error?: string } {
        if (!this.workspaces.has(name)) {
            return { success: false, error: `Workspace "${name}" not found` };
        }
        this.workspaces.delete(name);
        this.saveWorkspaces();
        return { success: true };
    }

    listWorkspaces(): Workspace[] {
        return Array.from(this.workspaces.values());
    }

    getCurrentWorkspace(): string {
        return this.currentWorkspaceName;
    }

    getWorkspaceInfo(): {
        current: string;
        available: Workspace[];
        config: ApiConfig;
    } {
        return {
            current: this.currentWorkspaceName,
            available: this.listWorkspaces(),
            config: this.getConfig(),
        };
    }
}
