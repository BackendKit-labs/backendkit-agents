import { AgentClient, CircuitBreakerState } from '@backendkit-labs/agent-protocol';
import type { AgentInfo, AgentContext, RunOptions } from '@backendkit-labs/agent-protocol';
import type { PoolStrategy } from './config.js';

// ── AgentPool ─────────────────────────────────────────────────────────────────

export class AgentPool {
    private readonly clients:      AgentClient[];
    private readonly strategy:     PoolStrategy;
    private rrIndex                = 0;
    private readonly activeCounts: Map<AgentClient, number>;

    constructor(clients: AgentClient[], strategy: PoolStrategy = 'round-robin') {
        if (clients.length === 0) throw new Error('AgentPool requires at least one client');
        this.clients      = clients;
        this.strategy     = strategy;
        this.activeCounts = new Map(clients.map(c => [c, 0]));
    }

    // ── Instance selection ────────────────────────────────────────────────────

    pick(): AgentClient {
        const available = this.availableClients();
        if (available.length === 0) throw new Error('No available agent instances (all circuit breakers OPEN)');

        switch (this.strategy) {
            case 'round-robin':  return this.pickRoundRobin(available);
            case 'least-busy':   return this.pickLeastBusy(available);
            case 'random':       return available[Math.floor(Math.random() * available.length)];
            case 'failover':     return available[0];
        }
    }

    private availableClients(): AgentClient[] {
        return this.clients.filter(c => c.getCircuitState() !== CircuitBreakerState.OPEN);
    }

    private pickRoundRobin(available: AgentClient[]): AgentClient {
        const idx = this.rrIndex % available.length;
        this.rrIndex = (this.rrIndex + 1) % available.length;
        return available[idx];
    }

    private pickLeastBusy(available: AgentClient[]): AgentClient {
        return available.reduce((best, c) =>
            (this.activeCounts.get(c) ?? 0) < (this.activeCounts.get(best) ?? 0) ? c : best
        );
    }

    // ── Execution ─────────────────────────────────────────────────────────────

    async runAndWait(
        capability: string,
        input:      Record<string, unknown>,
        opts:       RunOptions & { context?: AgentContext } = {},
    ): Promise<unknown> {
        const client = this.pick();
        this.activeCounts.set(client, (this.activeCounts.get(client) ?? 0) + 1);

        try {
            return await client.runAndWait(capability, input, opts);
        } catch (err) {
            // On failover strategy, retry with next available instance
            if (this.strategy === 'failover') {
                const fallback = this.availableClients().find(c => c !== client);
                if (fallback) {
                    return fallback.runAndWait(capability, input, opts);
                }
            }
            throw err;
        } finally {
            const c = this.activeCounts.get(client) ?? 1;
            this.activeCounts.set(client, Math.max(0, c - 1));
        }
    }

    // ── Health + discovery ────────────────────────────────────────────────────

    async health(): Promise<{ url: string; ok: boolean; circuitState: string }[]> {
        return Promise.all(
            this.clients.map(async c => ({
                url:          (c as any).baseUrl ?? '?',
                ok:           await c.health(),
                circuitState: c.getCircuitState(),
            }))
        );
    }

    async info(): Promise<AgentInfo> {
        return this.pick().info();
    }

    get size(): number { return this.clients.length; }
}
