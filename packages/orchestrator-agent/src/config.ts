import { z } from 'zod';
import { readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';

// ── Schemas ───────────────────────────────────────────────────────────────────

const TransportSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('stdio'),
        command: z.string(),
        args: z.array(z.string()).default([]),
        env: z.record(z.string()).optional(),
    }),
    z.object({
        type: z.literal('http'),
        url: z.string(),
    }),
]);

const AgentConfigSchema = z.object({
    id:             z.string(),
    name:           z.string(),
    description:    z.string(),
    capabilities:   z.array(z.string()),
    provider:       z.string().default('default'),
    system_prompt:  z.string().optional(),
    transport:      TransportSchema.optional(),
    gate:           z.boolean().optional(),           // pause for human approval after this agent
    gate_criteria:  z.array(z.string()).optional(),   // criteria shown to the approver
    domain:         z.string().optional(),            // enterprise reflection domain (e.g. 'rrhh', 'legal')
});

const ProviderConfigSchema = z.object({
    api_key: z.string().optional(),
    base_url: z.string().optional(),
    model: z.string(),
});

const VaultConfigSchema = z.object({
    path: z.string(),
    embedder: z.enum(['simple', 'ollama']).default('simple'),
    ollama_host: z.string().default('http://localhost:11434'),
    ollama_model: z.string().default('nomic-embed-text'),
});

const FlowEntryConfigSchema = z.object({
    id:      z.string(),
    file:    z.string(),
    trigger: z.string().optional(),
});

export const OrchestratorConfigSchema = z.object({
    version: z.number().default(1),
    orchestrator: z.object({
        name: z.string().default('Orchestrator'),
        provider: z.string().default('default'),
        model: z.string().optional(),
        vault: VaultConfigSchema.optional(),
    }),
    providers: z.record(ProviderConfigSchema).default({}),
    agents:    z.array(AgentConfigSchema).min(1, 'At least one agent must be configured'),
    flows:     z.array(FlowEntryConfigSchema).optional(),
});

// ── Types ─────────────────────────────────────────────────────────────────────

export type OrchestratorConfig = z.infer<typeof OrchestratorConfigSchema>;
export type AgentConfig        = z.infer<typeof AgentConfigSchema>;
export type ProviderConfig     = z.infer<typeof ProviderConfigSchema>;
export type VaultConfig        = z.infer<typeof VaultConfigSchema>;

// ── Loader ────────────────────────────────────────────────────────────────────

export function loadConfig(configPath: string): OrchestratorConfig {
    const resolved = path.resolve(configPath);
    if (!existsSync(resolved)) {
        throw new Error(`Config not found: ${resolved}`);
    }
    const raw  = yaml.parse(readFileSync(resolved, 'utf-8')) as unknown;
    const expanded = expandEnv(raw);
    const result   = OrchestratorConfigSchema.safeParse(expanded);
    if (!result.success) {
        const issues = result.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n');
        throw new Error(`Invalid orchestrator config:\n${issues}`);
    }
    return result.data;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function expandEnv(obj: unknown): unknown {
    if (typeof obj === 'string') {
        return obj.replace(/\$\{(\w+)\}/g, (_, key: string) => process.env[key] ?? '');
    }
    if (Array.isArray(obj)) return obj.map(expandEnv);
    if (obj !== null && typeof obj === 'object') {
        return Object.fromEntries(
            Object.entries(obj as Record<string, unknown>).map(([k, v]) => [k, expandEnv(v)])
        );
    }
    return obj;
}

export function resolveProviderConfig(config: OrchestratorConfig, providerId: string): ProviderConfig | null {
    return config.providers[providerId] ?? null;
}
