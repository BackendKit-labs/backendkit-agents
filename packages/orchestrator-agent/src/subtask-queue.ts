import { Queue, QueueEvents } from 'bullmq';
import IORedis                from 'ioredis';
import type { SubTask }       from './planner.js';
import type { ExecutionResult } from './executor.js';

export interface SubtaskJobData {
    subtask:      SubTask;
    priorResults: ExecutionResult[];
    configPath:   string;
}

export class SubtaskQueue {
    private readonly connection: IORedis;
    private readonly queues     = new Map<string, Queue<SubtaskJobData, ExecutionResult>>();
    private readonly events     = new Map<string, QueueEvents>();

    constructor(redisUrl: string) {
        this.connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    }

    private ensure(agentId: string): { queue: Queue<SubtaskJobData, ExecutionResult>; events: QueueEvents } {
        if (!this.queues.has(agentId)) {
            const name = `subtasks.${agentId}`;
            this.queues.set(agentId, new Queue(name, { connection: this.connection }));
            this.events.set(agentId, new QueueEvents(name, { connection: this.connection }));
        }
        return {
            queue:  this.queues.get(agentId)!,
            events: this.events.get(agentId)!,
        };
    }

    async dispatch(
        subtask:      SubTask,
        priorResults: ExecutionResult[],
        configPath:   string,
    ): Promise<ExecutionResult> {
        const { queue, events } = this.ensure(subtask.agent_id);
        const job = await queue.add('run', { subtask, priorResults, configPath }, {
            attempts:         3,
            backoff:          { type: 'exponential', delay: 2000 },
            removeOnComplete: 100,
            removeOnFail:     50,
        });
        return job.waitUntilFinished(events) as Promise<ExecutionResult>;
    }

    async close(): Promise<void> {
        await Promise.all([
            ...Array.from(this.queues.values()).map(q => q.close()),
            ...Array.from(this.events.values()).map(e => e.close()),
        ]);
        this.connection.disconnect();
    }
}
