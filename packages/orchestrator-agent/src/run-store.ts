import * as fs   from 'node:fs';
import * as path from 'node:path';
import * as os   from 'node:os';

// ── Types ─────────────────────────────────────────────────────────────────────

export type RunStatus = 'running' | 'waiting_gate' | 'complete' | 'failed';

export interface StepResult {
    stepId:     string;
    agentId:    string;
    task:       string;
    output:     string;
    success:    boolean;
    durationMs: number;
}

export interface GatePending {
    gateId:          string;   // same as stepId — one gate per step
    stepId:          string;
    agentId:         string;
    output:          string;   // agent output shown to the human approver
    criteria:        string[];
    requestedAt:     string;
    /** IDs of policyRules that triggered this gate automatically (Cable 2). */
    appliedRuleIds?: string[];
}

export interface RunState {
    runId:           string;
    task:            string;
    configPath:      string;
    status:          RunStatus;
    startedAt:       string;
    updatedAt:       string;
    completedAt?:    string;
    plan?:           unknown;            // TaskPlan — stored for resume
    completedSteps:  StepResult[];
    currentStep?:    { stepId: string; agentId: string; startedAt: string };
    waitingGate?:    GatePending;
    vaultNotePath?:  string;            // path of the vault note written on completion
    finalReport?:    string;
    error?:          string;
}

// ── RunStore ──────────────────────────────────────────────────────────────────

const DEFAULT_DIR = path.join(os.homedir(), '.bk-agent', 'orchestrator', 'runs');

export class RunStore {
    private readonly dir: string;

    constructor(dir = DEFAULT_DIR) {
        this.dir = dir;
        fs.mkdirSync(this.dir, { recursive: true });
    }

    newRunId(): string {
        return `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    }

    save(state: RunState): void {
        const updated: RunState = { ...state, updatedAt: new Date().toISOString() };
        fs.writeFileSync(
            path.join(this.dir, `${state.runId}.json`),
            JSON.stringify(updated, null, 2),
            'utf-8',
        );
    }

    load(runId: string): RunState | null {
        try {
            return JSON.parse(
                fs.readFileSync(path.join(this.dir, `${runId}.json`), 'utf-8'),
            ) as RunState;
        } catch {
            return null;
        }
    }
}
