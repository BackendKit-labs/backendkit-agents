import Database from 'better-sqlite3';
import * as fs   from 'node:fs';
import * as path from 'node:path';
import type { OrchestratorMcpConfig } from './config.js';
import type { Flow } from './flow.js';

// ── Public types ──────────────────────────────────────────────────────────────

export interface StoredAgent {
    id:             string;
    description?:   string;
    transport:      string;
    strategy:       string;
    timeout?:       number;
    capability:     string;
    gate:           boolean;
    gate_criteria?: string[];
    image?:         string;   // Docker image for containerised deployment
    instances:      { url: string; apiKey?: string }[];
}

export interface StoredFlowStep {
    id:             string;
    agent:          string;
    task:           string;
    capability?:    string;
    input?:         Record<string, unknown>;
    depends_on:     string[];
    gate:           boolean;
    gate_criteria?: string[];
    required:       boolean;
    position:       number;
}

export interface StoredFlow {
    id:           string;
    name:         string;
    description?: string;
    trigger?:     string;
    steps:        StoredFlowStep[];
}

// ── Row shapes ────────────────────────────────────────────────────────────────

interface AgentRow    { id: string; description: string|null; transport: string; strategy: string; timeout: number|null; capability: string; gate: number; gate_criteria: string|null; image: string|null; updatedAt: string; }
interface InstanceRow { id: number; agent_id: string; url: string; api_key: string|null; position: number; }
interface FlowRow     { id: string; name: string; description: string|null; trigger: string|null; updatedAt: string; }
interface StepRow     { flow_id: string; step_id: string; agent: string; task: string; capability: string|null; input: string|null; depends_on: string; gate: number; gate_criteria: string|null; required: number; position: number; }

// ── ConfigStore ───────────────────────────────────────────────────────────────

export class ConfigStore {
    private readonly db: Database.Database;

    constructor(dbPath: string) {
        fs.mkdirSync(path.dirname(dbPath), { recursive: true });
        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('synchronous = NORMAL');
        this.db.pragma('foreign_keys = ON');

        // Migration: add image column for existing DBs
        try { this.db.exec('ALTER TABLE agents ADD COLUMN image TEXT'); } catch {}

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS agents (
                id            TEXT PRIMARY KEY,
                description   TEXT,
                transport     TEXT NOT NULL DEFAULT 'http',
                strategy      TEXT NOT NULL DEFAULT 'round-robin',
                timeout       INTEGER,
                capability    TEXT NOT NULL DEFAULT 'execute',
                gate          INTEGER NOT NULL DEFAULT 0,
                gate_criteria TEXT,
                image         TEXT,
                updatedAt     TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS agent_instances (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                agent_id  TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
                url       TEXT NOT NULL,
                api_key   TEXT,
                position  INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS flows (
                id          TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                description TEXT,
                trigger     TEXT,
                updatedAt   TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS flow_steps (
                flow_id       TEXT NOT NULL REFERENCES flows(id) ON DELETE CASCADE,
                step_id       TEXT NOT NULL,
                agent         TEXT NOT NULL,
                task          TEXT NOT NULL,
                capability    TEXT,
                input         TEXT,
                depends_on    TEXT NOT NULL DEFAULT '[]',
                gate          INTEGER NOT NULL DEFAULT 0,
                gate_criteria TEXT,
                required      INTEGER NOT NULL DEFAULT 0,
                position      INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (flow_id, step_id)
            );
        `);
    }

    // ── Agents ────────────────────────────────────────────────────────────────

    saveAgent(a: StoredAgent): void {
        const now = new Date().toISOString();
        this.db.transaction(() => {
            this.db.prepare(`
                INSERT INTO agents (id, description, transport, strategy, timeout, capability, gate, gate_criteria, image, updatedAt)
                VALUES (@id, @description, @transport, @strategy, @timeout, @capability, @gate, @gate_criteria, @image, @updatedAt)
                ON CONFLICT(id) DO UPDATE SET
                    description=excluded.description, transport=excluded.transport, strategy=excluded.strategy,
                    timeout=excluded.timeout, capability=excluded.capability, gate=excluded.gate,
                    gate_criteria=excluded.gate_criteria, image=excluded.image, updatedAt=excluded.updatedAt
            `).run({
                id: a.id, description: a.description ?? null, transport: a.transport, strategy: a.strategy,
                timeout: a.timeout ?? null, capability: a.capability, gate: a.gate ? 1 : 0,
                gate_criteria: a.gate_criteria ? JSON.stringify(a.gate_criteria) : null,
                image: a.image ?? null, updatedAt: now,
            });
            this.db.prepare('DELETE FROM agent_instances WHERE agent_id = ?').run(a.id);
            a.instances.forEach((inst, i) => {
                this.db.prepare('INSERT INTO agent_instances (agent_id, url, api_key, position) VALUES (?, ?, ?, ?)')
                    .run(a.id, inst.url, inst.apiKey ?? null, i);
            });
        })();
    }

    getAgent(id: string): StoredAgent | null {
        const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as AgentRow | undefined;
        return row ? this.hydrateAgent(row) : null;
    }

    listAgents(): StoredAgent[] {
        return (this.db.prepare('SELECT * FROM agents ORDER BY id').all() as AgentRow[]).map(r => this.hydrateAgent(r));
    }

    deleteAgent(id: string): void {
        this.db.prepare('DELETE FROM agents WHERE id = ?').run(id);
    }

    private hydrateAgent(row: AgentRow): StoredAgent {
        const instances = (this.db.prepare('SELECT * FROM agent_instances WHERE agent_id = ? ORDER BY position').all(row.id) as InstanceRow[])
            .map(i => ({ url: i.url, ...(i.api_key ? { apiKey: i.api_key } : {}) }));
        return {
            id: row.id, description: row.description ?? undefined, transport: row.transport,
            strategy: row.strategy, timeout: row.timeout ?? undefined, capability: row.capability,
            gate: row.gate === 1,
            gate_criteria: row.gate_criteria ? JSON.parse(row.gate_criteria) as string[] : undefined,
            image: row.image ?? undefined,
            instances,
        };
    }

    // ── Flows ─────────────────────────────────────────────────────────────────

    saveFlow(f: StoredFlow): void {
        const now = new Date().toISOString();
        this.db.transaction(() => {
            this.db.prepare(`
                INSERT INTO flows (id, name, description, trigger, updatedAt)
                VALUES (@id, @name, @description, @trigger, @updatedAt)
                ON CONFLICT(id) DO UPDATE SET
                    name=excluded.name, description=excluded.description,
                    trigger=excluded.trigger, updatedAt=excluded.updatedAt
            `).run({ id: f.id, name: f.name, description: f.description ?? null, trigger: f.trigger ?? null, updatedAt: now });
            this.db.prepare('DELETE FROM flow_steps WHERE flow_id = ?').run(f.id);
            f.steps.forEach((s, i) => {
                this.db.prepare(`
                    INSERT INTO flow_steps (flow_id, step_id, agent, task, capability, input, depends_on, gate, gate_criteria, required, position)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(f.id, s.id, s.agent, s.task, s.capability ?? null,
                    s.input ? JSON.stringify(s.input) : null,
                    JSON.stringify(s.depends_on), s.gate ? 1 : 0,
                    s.gate_criteria ? JSON.stringify(s.gate_criteria) : null,
                    s.required ? 1 : 0, i);
            });
        })();
    }

    getFlow(id: string): StoredFlow | null {
        const row = this.db.prepare('SELECT * FROM flows WHERE id = ?').get(id) as FlowRow | undefined;
        return row ? this.hydrateFlow(row) : null;
    }

    listFlows(): StoredFlow[] {
        return (this.db.prepare('SELECT * FROM flows ORDER BY id').all() as FlowRow[]).map(r => this.hydrateFlow(r));
    }

    deleteFlow(id: string): void {
        this.db.prepare('DELETE FROM flows WHERE id = ?').run(id);
    }

    private hydrateFlow(row: FlowRow): StoredFlow {
        const steps = (this.db.prepare('SELECT * FROM flow_steps WHERE flow_id = ? ORDER BY position').all(row.id) as StepRow[])
            .map(s => ({
                id: s.step_id, agent: s.agent, task: s.task, capability: s.capability ?? undefined,
                input: s.input ? JSON.parse(s.input) as Record<string, unknown> : undefined,
                depends_on: JSON.parse(s.depends_on) as string[],
                gate: s.gate === 1,
                gate_criteria: s.gate_criteria ? JSON.parse(s.gate_criteria) as string[] : undefined,
                required: s.required === 1, position: s.position,
            }));
        return { id: row.id, name: row.name, description: row.description ?? undefined, trigger: row.trigger ?? undefined, steps };
    }

    // ── Utils ─────────────────────────────────────────────────────────────────

    isEmpty(): boolean {
        return (this.db.prepare('SELECT COUNT(*) as n FROM agents').get() as { n: number }).n === 0;
    }

    /** Convert StoredFlow to the executor's Flow type */
    static toExecutorFlow(sf: StoredFlow): Flow {
        return {
            version: 2, id: sf.id, name: sf.name, description: sf.description,
            steps: sf.steps.map(s => ({
                id: s.id, agent: s.agent, task: s.task,
                capability: s.capability, input: s.input,
                depends_on: s.depends_on,
                gate: s.gate || undefined,
                gate_criteria: s.gate_criteria,
                required: s.required || undefined,
            })),
        };
    }

    /** Seed from YAML config + pre-loaded flows (called on first run when DB is empty) */
    seedFromYaml(config: OrchestratorMcpConfig, flows: StoredFlow[]): void {
        for (const a of config.agents) {
            this.saveAgent({
                id: a.id, description: a.description, transport: a.transport,
                strategy: a.strategy, timeout: a.timeout, capability: a.capability,
                gate: a.gate ?? false, gate_criteria: a.gate_criteria,
                instances: (a.instances ?? []).map(i => ({ url: i.url, apiKey: i.apiKey })),
            });
        }
        for (const f of flows) this.saveFlow(f);
    }
}
