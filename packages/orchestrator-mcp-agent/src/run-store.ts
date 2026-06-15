import Database from 'better-sqlite3';
import * as path  from 'node:path';
import * as fs    from 'node:fs';
import type { StepResult } from './executor.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type RunStatus = 'running' | 'waiting_gate' | 'waiting_retry' | 'done' | 'failed' | 'cancelled';

export interface RunState {
    id:             string;
    flowId:         string;
    status:         RunStatus;
    input:          Record<string, unknown>;
    results:        StepResult[];
    currentStepId?: string;
    gateStepId?:    string;
    gateCriteria?:  string[];
    failedStepId?:  string;
    summary?:       string;
    error?:         string;
    createdAt:      string;
    updatedAt:      string;
}

// ── Row shape (SQLite stores JSON fields as text) ─────────────────────────────

interface RunRow {
    id:             string;
    flowId:         string;
    status:         string;
    input:          string;
    results:        string;
    currentStepId:  string | null;
    gateStepId:     string | null;
    gateCriteria:   string | null;
    failedStepId:   string | null;
    summary:        string | null;
    error:          string | null;
    createdAt:      string;
    updatedAt:      string;
}

function rowToState(row: RunRow): RunState {
    return {
        id:             row.id,
        flowId:         row.flowId,
        status:         row.status as RunStatus,
        input:          JSON.parse(row.input) as Record<string, unknown>,
        results:        JSON.parse(row.results) as StepResult[],
        currentStepId:  row.currentStepId  ?? undefined,
        gateStepId:     row.gateStepId     ?? undefined,
        gateCriteria:   row.gateCriteria   ? JSON.parse(row.gateCriteria) as string[] : undefined,
        failedStepId:   row.failedStepId   ?? undefined,
        summary:        row.summary        ?? undefined,
        error:          row.error          ?? undefined,
        createdAt:      row.createdAt,
        updatedAt:      row.updatedAt,
    };
}

// ── RunStore — SQLite-backed persistence ──────────────────────────────────────

export class RunStore {
    private readonly db: Database.Database;

    private readonly upsert: Database.Statement;
    private readonly selectById: Database.Statement;
    private readonly selectAll: Database.Statement;
    private readonly deleteById: Database.Statement;

    constructor(dbPath: string) {
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS runs (
                id             TEXT PRIMARY KEY,
                flowId         TEXT NOT NULL,
                status         TEXT NOT NULL,
                input          TEXT NOT NULL,
                results        TEXT NOT NULL,
                currentStepId  TEXT,
                gateStepId     TEXT,
                gateCriteria   TEXT,
                failedStepId   TEXT,
                summary        TEXT,
                error          TEXT,
                createdAt      TEXT NOT NULL,
                updatedAt      TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_runs_status    ON runs(status);
            CREATE INDEX IF NOT EXISTS idx_runs_createdAt ON runs(createdAt DESC);
        `);
        // Migrate existing DBs that predate new columns
        for (const col of ['currentStepId TEXT', 'gateCriteria TEXT']) {
            try { this.db.exec(`ALTER TABLE runs ADD COLUMN ${col}`); } catch { /* already exists */ }
        }

        this.upsert = this.db.prepare(`
            INSERT INTO runs (id, flowId, status, input, results, currentStepId, gateStepId, gateCriteria, failedStepId, summary, error, createdAt, updatedAt)
            VALUES (@id, @flowId, @status, @input, @results, @currentStepId, @gateStepId, @gateCriteria, @failedStepId, @summary, @error, @createdAt, @updatedAt)
            ON CONFLICT(id) DO UPDATE SET
                status        = excluded.status,
                results       = excluded.results,
                currentStepId = excluded.currentStepId,
                gateStepId    = excluded.gateStepId,
                gateCriteria  = excluded.gateCriteria,
                failedStepId  = excluded.failedStepId,
                summary       = excluded.summary,
                error         = excluded.error,
                updatedAt     = excluded.updatedAt
        `);

        this.selectById = this.db.prepare(`SELECT * FROM runs WHERE id = ?`);
        this.selectAll  = this.db.prepare(`SELECT * FROM runs ORDER BY createdAt DESC`);
        this.deleteById = this.db.prepare(`DELETE FROM runs WHERE id = ?`);
    }

    async save(run: RunState): Promise<void> {
        this.upsert.run({
            id:            run.id,
            flowId:        run.flowId,
            status:        run.status,
            input:         JSON.stringify(run.input),
            results:       JSON.stringify(run.results),
            currentStepId: run.currentStepId  ?? null,
            gateStepId:    run.gateStepId     ?? null,
            gateCriteria:  run.gateCriteria   ? JSON.stringify(run.gateCriteria) : null,
            failedStepId:  run.failedStepId   ?? null,
            summary:       run.summary        ?? null,
            error:         run.error          ?? null,
            createdAt:     run.createdAt,
            updatedAt:     run.updatedAt,
        });
    }

    async get(id: string): Promise<RunState | null> {
        const row = this.selectById.get(id) as RunRow | undefined;
        return row ? rowToState(row) : null;
    }

    async list(): Promise<RunState[]> {
        return (this.selectAll.all() as RunRow[]).map(rowToState);
    }

    async delete(id: string): Promise<void> {
        this.deleteById.run(id);
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
