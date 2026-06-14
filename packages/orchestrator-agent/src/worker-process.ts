#!/usr/bin/env node

// Load .env without external deps — same pattern as server.ts
import * as fsSync   from 'node:fs';
import * as pathSync from 'node:path';
import { fileURLToPath } from 'node:url';
(function loadDotEnv() {
    const pkgRoot    = pathSync.resolve(fileURLToPath(import.meta.url), '..', '..');
    const candidates = [pathSync.join(process.cwd(), '.env'), pathSync.join(pkgRoot, '.env')];
    for (const f of candidates) {
        if (!fsSync.existsSync(f)) continue;
        for (const line of fsSync.readFileSync(f, 'utf-8').split('\n')) {
            const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
            if (m && m[2] && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
        }
        break;
    }
})();

import { Worker }    from 'bullmq';
import IORedis       from 'ioredis';
import * as path     from 'node:path';
import { loadConfig, resolveDataDir } from './config.js';
import { executeSubtask }             from './executor.js';
import { buildRAG }                   from './rag.js';
import type { SubtaskJobData }        from './subtask-queue.js';
import type { ExecutionResult }       from './executor.js';

const configPath = process.env['ORCHESTRATOR_CONFIG'];
const redisUrl   = process.env['ORCHESTRATOR_REDIS_URL'];

if (!configPath || !redisUrl) {
    process.stderr.write(
        '[orchestrator-worker] ORCHESTRATOR_CONFIG and ORCHESTRATOR_REDIS_URL are required\n',
    );
    process.exit(1);
}

let config: ReturnType<typeof loadConfig>;
try {
    config = loadConfig(configPath);
} catch (err) {
    process.stderr.write(`[orchestrator-worker] Config error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
}

const resolvedConfig = path.resolve(configPath);
const dataDir        = resolveDataDir(resolvedConfig, config);

// Pre-build RAG index once per worker process
const ragPromise = buildRAG(config, dataDir).catch(() => null);

const connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });

const workers = config.agents.map(agent => {
    const worker = new Worker<SubtaskJobData, ExecutionResult>(
        `subtasks.${agent.id}`,
        async (job) => {
            const { subtask, priorResults } = job.data;
            const rag = await ragPromise;
            const start = Date.now();
            try {
                const result = await executeSubtask(
                    config,
                    agent,
                    subtask,
                    priorResults,
                    rag?.search,
                );
                return {
                    subtask_id:  subtask.id,
                    agent_id:    subtask.agent_id,
                    task:        subtask.task,
                    result,
                    success:     true,
                    duration_ms: Date.now() - start,
                } satisfies ExecutionResult;
            } catch (err) {
                return {
                    subtask_id:  subtask.id,
                    agent_id:    subtask.agent_id,
                    task:        subtask.task,
                    result:      `Error: ${err instanceof Error ? err.message : String(err)}`,
                    success:     false,
                    duration_ms: Date.now() - start,
                } satisfies ExecutionResult;
            }
        },
        { connection, concurrency: 4 },
    );

    worker.on('completed', (job, result) => {
        process.stderr.write(
            `[worker:${agent.id}] completed ${job.id}: ${result.success ? 'ok' : 'failed'}\n`,
        );
    });

    worker.on('failed', (job, err) => {
        process.stderr.write(
            `[worker:${agent.id}] failed ${job?.id ?? '?'}: ${err.message}\n`,
        );
    });

    return worker;
});

process.stderr.write(
    `[orchestrator-worker] Ready — ${workers.length} worker(s): ${config.agents.map(a => a.id).join(', ')}\n` +
    `[orchestrator-worker] Config: ${resolvedConfig}\n` +
    `[orchestrator-worker] Redis:  ${redisUrl.replace(/:\/\/[^@]*@/, '://**:**@')}\n`,
);

async function shutdown() {
    process.stderr.write('[orchestrator-worker] Shutting down…\n');
    await Promise.all(workers.map(w => w.close()));
    connection.disconnect();
    process.exit(0);
}

process.on('SIGTERM', () => { shutdown().catch(() => process.exit(1)); });
process.on('SIGINT',  () => { shutdown().catch(() => process.exit(1)); });
