import { AgentClient } from '@backendkit-labs/agent-protocol';
import { AgentPool }   from './pool.js';
import type { OrchestratorMcpConfig, AgentConfig } from './config.js';

// ── PoolRegistry ──────────────────────────────────────────────────────────────

export class PoolRegistry {
    private readonly pools:         Map<string, AgentPool>;
    private readonly agentConfigs:  Map<string, AgentConfig>;
    private readonly globalApiKey?: string;
    private readonly tenantId?:     string;

    constructor(config: OrchestratorMcpConfig) {
        this.globalApiKey  = config.orchestrator.api_key;
        this.tenantId      = config.orchestrator.tenant_id;
        this.pools         = new Map();
        this.agentConfigs  = new Map();

        for (const agent of config.agents) {
            this.agentConfigs.set(agent.id, agent);

            if (agent.transport === 'http') {
                if (!agent.instances || agent.instances.length === 0) {
                    throw new Error(`Agent '${agent.id}': transport=http requires at least one instance`);
                }

                const clients = agent.instances.map(inst =>
                    new AgentClient({
                        url:            inst.url,
                        apiKey:         inst.apiKey ?? this.globalApiKey,
                        tenantId:       this.tenantId,
                        maxRetries:     3,
                        circuitBreaker: true,
                        ...(agent.timeout !== undefined && { timeout: agent.timeout }),
                    })
                );

                this.pools.set(agent.id, new AgentPool(clients, agent.strategy));

            } else {
                // stdio — placeholder, pool will be added in future
                throw new Error(`Agent '${agent.id}': transport=stdio not yet supported in orchestrator-mcp-agent`);
            }
        }
    }

    get(agentId: string): AgentPool {
        const pool = this.pools.get(agentId);
        if (!pool) throw new Error(`No pool registered for agent '${agentId}'`);
        return pool;
    }

    config(agentId: string): AgentConfig {
        const cfg = this.agentConfigs.get(agentId);
        if (!cfg) throw new Error(`No config for agent '${agentId}'`);
        return cfg;
    }

    agentIds(): string[] {
        return [...this.pools.keys()];
    }

    async healthAll(): Promise<Record<string, Awaited<ReturnType<AgentPool['health']>>>> {
        const result: Record<string, Awaited<ReturnType<AgentPool['health']>>> = {};
        for (const [id, pool] of this.pools) {
            result[id] = await pool.health();
        }
        return result;
    }
}
