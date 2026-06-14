import { z }                        from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import * as path                    from 'node:path';
import * as yaml                    from 'yaml';

// ── Agent pool ────────────────────────────────────────────────────────────────

const InstanceSchema = z.object({
    url:    z.string().url(),
    apiKey: z.string().optional(),
});

const StrategySchema = z.enum(['round-robin', 'least-busy', 'random', 'failover'])
    .default('round-robin');

const AgentConfigSchema = z.object({
    id:             z.string(),
    description:    z.string().optional(),
    transport:      z.enum(['http', 'stdio']).default('http'),
    // HTTP pool
    instances:      z.array(InstanceSchema).min(1).optional(),
    strategy:       StrategySchema,
    // Per-agent default capability (what to call when a flow step doesn't specify one)
    capability:     z.string().default('execute'),
    // Gate config (same semantics as orchestrator-agent)
    gate:           z.boolean().optional(),
    gate_criteria:  z.array(z.string()).optional(),
    // stdio (future — parsed but not yet wired)
    command:        z.string().optional(),
    args:           z.array(z.string()).default([]),
});

// ── Vault ─────────────────────────────────────────────────────────────────────

const VaultConfigSchema = z.object({
    path:    z.string(),
    embedder: z.enum(['simple', 'ollama']).default('simple'),
});

// ── Flows ─────────────────────────────────────────────────────────────────────

const FlowEntrySchema = z.object({
    id:      z.string(),
    file:    z.string(),
    trigger: z.string().optional(),
});

// ── Root config ───────────────────────────────────────────────────────────────

export const OrchestratorMcpConfigSchema = z.object({
    version:     z.number().default(2),
    orchestrator: z.object({
        name:     z.string().default('Orchestrator MCP'),
        vault:    VaultConfigSchema.optional(),
        data_dir: z.string().optional(),
        // Global API key for agent-protocol auth (agents may override per-instance)
        api_key:  z.string().optional(),
        tenant_id: z.string().optional(),
    }),
    agents: z.array(AgentConfigSchema).min(1),
    flows:  z.array(FlowEntrySchema).optional().default([]),
});

export type OrchestratorMcpConfig = z.infer<typeof OrchestratorMcpConfigSchema>;
export type AgentConfig            = z.infer<typeof AgentConfigSchema>;
export type InstanceConfig         = z.infer<typeof InstanceSchema>;
export type PoolStrategy           = z.infer<typeof StrategySchema>;
export type FlowEntry              = z.infer<typeof FlowEntrySchema>;

// ── Loader ────────────────────────────────────────────────────────────────────

export function loadConfig(configPath: string): OrchestratorMcpConfig {
    const resolved = path.resolve(configPath);
    if (!existsSync(resolved)) throw new Error(`Config not found: ${resolved}`);

    const raw      = yaml.parse(readFileSync(resolved, 'utf-8')) as unknown;
    const expanded = expandEnv(raw);
    const result   = OrchestratorMcpConfigSchema.safeParse(expanded);

    if (!result.success) {
        const issues = result.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n');
        throw new Error(`Invalid orchestrator-mcp config:\n${issues}`);
    }
    return result.data;
}

export function resolveDataDir(configPath: string, config?: OrchestratorMcpConfig): string {
    if (process.env['ORCHESTRATOR_DATA_DIR']) return process.env['ORCHESTRATOR_DATA_DIR'];
    if (config?.orchestrator.data_dir) {
        return path.resolve(path.dirname(path.resolve(configPath)), config.orchestrator.data_dir);
    }
    return path.join(path.dirname(path.resolve(configPath)), '.orchestrator-mcp');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function expandEnv(obj: unknown): unknown {
    if (typeof obj === 'string') {
        return obj.replace(/\$\{(\w+)\}/g, (_, k: string) => process.env[k] ?? '');
    }
    if (Array.isArray(obj)) return obj.map(expandEnv);
    if (obj !== null && typeof obj === 'object') {
        return Object.fromEntries(
            Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, expandEnv(v)])
        );
    }
    return obj;
}
