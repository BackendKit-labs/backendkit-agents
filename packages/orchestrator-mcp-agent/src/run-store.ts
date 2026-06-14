import * as fs   from 'node:fs';
import * as path from 'node:path';
import type { StepResult } from './executor.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type RunStatus = 'running' | 'waiting_gate' | 'done' | 'failed' | 'cancelled';

export interface RunState {
    id:            string;
    flowId:        string;
    status:        RunStatus;
    input:         Record<string, unknown>;
    results:       StepResult[];
    gateStepId?:   string;
    failedStepId?: string;
    summary?:      string;
    error?:        string;
    createdAt:     string;
    updatedAt:     string;
}

// ── RunStore — simple file-based persistence ──────────────────────────────────

export class RunStore {
    private readonly dir: string;

    constructor(dir: string) {
        this.dir = dir;
        fs.mkdirSync(dir, { recursive: true });
    }

    async save(run: RunState): Promise<void> {
        const file = path.join(this.dir, `${run.id}.json`);
        fs.writeFileSync(file, JSON.stringify(run, null, 2), 'utf-8');
    }

    async get(id: string): Promise<RunState | null> {
        const file = path.join(this.dir, `${id}.json`);
        if (!fs.existsSync(file)) return null;
        return JSON.parse(fs.readFileSync(file, 'utf-8')) as RunState;
    }

    async list(): Promise<RunState[]> {
        if (!fs.existsSync(this.dir)) return [];
        const files = fs.readdirSync(this.dir).filter(f => f.endsWith('.json'));
        return files.map(f =>
            JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf-8')) as RunState
        ).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }

    async delete(id: string): Promise<void> {
        const file = path.join(this.dir, `${id}.json`);
        if (fs.existsSync(file)) fs.unlinkSync(file);
    }

    newRun(flowId: string, input: Record<string, unknown>): RunState {
        const now = new Date().toISOString();
        return {
            id:        crypto.randomUUID(),
            flowId,
            status:    'running',
            input,
            results:   [],
            createdAt: now,
            updatedAt: now,
        };
    }
}
