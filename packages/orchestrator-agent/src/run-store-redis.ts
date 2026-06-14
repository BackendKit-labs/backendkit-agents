import { createHash }           from 'node:crypto';
import type { Redis }           from 'ioredis';
import type { IRunStore, RunState } from './run-store.js';

/** Derives a short, stable Redis key prefix from the absolute config path. */
export function redisPrefix(configPath: string): string {
    return `orchestrator:${createHash('sha256').update(configPath).digest('hex').slice(0, 12)}`;
}

export class RedisRunStore implements IRunStore {
    private readonly indexKey: string;

    constructor(
        private readonly redis: Redis,
        private readonly prefix: string,
    ) {
        this.indexKey = `${prefix}:runs`;
    }

    newRunId(): string {
        return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }

    async save(state: RunState): Promise<void> {
        const updated = { ...state, updatedAt: new Date().toISOString() };
        const score   = new Date(state.startedAt).getTime();
        await this.redis.set(`${this.prefix}:run:${state.runId}`, JSON.stringify(updated));
        await this.redis.zadd(this.indexKey, score, state.runId);
    }

    async load(runId: string): Promise<RunState | null> {
        const data = await this.redis.get(`${this.prefix}:run:${runId}`);
        return data ? JSON.parse(data) as RunState : null;
    }

    async list(): Promise<RunState[]> {
        const ids    = await this.redis.zrevrange(this.indexKey, 0, -1);
        const states = await Promise.all(ids.map(id => this.load(id)));
        return states.filter((s): s is RunState => s !== null);
    }

    async prune(maxAgeDays = 30): Promise<number> {
        const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
        const oldIds = await this.redis.zrangebyscore(this.indexKey, '-inf', String(cutoff));
        let removed  = 0;
        for (const id of oldIds) {
            const state = await this.load(id);
            if (state && (state.status === 'complete' || state.status === 'failed')) {
                await this.redis.del(`${this.prefix}:run:${id}`);
                await this.redis.zrem(this.indexKey, id);
                removed++;
            }
        }
        return removed;
    }
}
