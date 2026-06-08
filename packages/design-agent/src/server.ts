#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cwdToProjectKey } from '@backendkit-labs/agent-core';

const APP_NAME = process.env.BK_APP_NAME ?? 'bk-agent';

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * Spec-driven lifecycle per phase:
 *   spec → implement → verify → (next phase or blocked back to implement)
 */
type PhaseStage  = 'spec' | 'implement' | 'verify';
type PhaseStatus = 'pending' | 'in_progress' | 'complete' | 'blocked';

interface Phase {
    number: number;
    name: string;
    description: string;
    criteria: string[];
    status: PhaseStatus;
    stage: PhaseStage;
    specPath?: string;
    startedAt?: string;
    completedAt?: string;
    log?: string[];
}

interface DesignState {
    project: string;
    cwd: string;
    description: string;
    createdAt: string;
    updatedAt: string;
    currentPhase: number;
    phases: Phase[];
}

// ── DesignStore ───────────────────────────────────────────────────────────────

class DesignStore {
    private readonly dir: string;
    private readonly statePath: string;

    constructor(cwd: string, appName = APP_NAME) {
        const key = cwdToProjectKey(cwd);
        this.dir = join(homedir(), `.${appName}`, 'design', 'projects', key);
        this.statePath = join(this.dir, 'design.json');
        mkdirSync(this.dir, { recursive: true });
    }

    exists(): boolean {
        return existsSync(this.statePath);
    }

    read(): DesignState {
        return JSON.parse(readFileSync(this.statePath, 'utf-8')) as DesignState;
    }

    write(state: DesignState): void {
        state.updatedAt = new Date().toISOString().slice(0, 10);
        writeFileSync(this.statePath, JSON.stringify(state, null, 2), 'utf-8');
    }

    static listAll(appName = APP_NAME): Array<{ key: string; state?: DesignState }> {
        const base = join(homedir(), `.${appName}`, 'design', 'projects');
        if (!existsSync(base)) return [];
        return readdirSync(base, { withFileTypes: true })
            .filter(d => d.isDirectory())
            .map(d => {
                const statePath = join(base, d.name, 'design.json');
                try {
                    return { key: d.name, state: JSON.parse(readFileSync(statePath, 'utf-8')) as DesignState };
                } catch {
                    return { key: d.name };
                }
            });
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function now(): string { return new Date().toISOString().slice(0, 10); }
function ts():  string { return new Date().toISOString().slice(0, 16); }

function activePhase(state: DesignState): Phase | undefined {
    return state.phases.find(p => p.number === state.currentPhase);
}

const STAGE_LABEL: Record<PhaseStage, string> = {
    spec:      '📐 SPEC',
    implement: '🔨 IMPLEMENT',
    verify:    '✅ VERIFY',
};

/** Human-readable instructions per stage */
function stageInstructions(phase: Phase, total: number): string {
    const header = `**Phase ${phase.number}/${total}: ${phase.name}** — ${STAGE_LABEL[phase.stage]}`;
    const criteria = phase.criteria.length
        ? '\n\n**Criteria to satisfy:**\n' + phase.criteria.map(c => `- [ ] ${c}`).join('\n')
        : '';

    switch (phase.stage) {
        case 'spec':
            return [
                header,
                '',
                phase.description,
                criteria,
                '',
                '**Your task (SPEC stage):**',
                '1. Write formal interfaces, types, and API contracts for this phase.',
                '2. Write test cases or acceptance scenarios that define "done".',
                `3. Save the spec to \`docs/spec-phase${phase.number}.md\` (or equivalent).`,
                '',
                'When spec is written, call `design_advance` with notes="path/to/spec.md".',
            ].join('\n');

        case 'implement':
            return [
                header,
                '',
                phase.description,
                phase.specPath ? `\n**Spec:** \`${phase.specPath}\` — implement to satisfy this spec.` : '',
                criteria,
                '',
                '**Your task (IMPLEMENT stage):**',
                '1. Write code that satisfies the spec and criteria above.',
                '2. Follow the contracts defined in the spec document.',
                '3. Do NOT skip the spec — implementation must match it.',
                '',
                'When implementation is ready for testing, call `design_advance` with notes summarizing what you built.',
            ].join('\n');

        case 'verify':
            return [
                header,
                '',
                phase.description,
                phase.specPath ? `\n**Spec:** \`${phase.specPath}\`` : '',
                criteria,
                '',
                '**Your task (VERIFY stage):**',
                '1. Run tests, type checks, and linting.',
                '2. Verify each criterion above is satisfied.',
                '3. Confirm the implementation matches the spec.',
                '',
                'Call `design_advance` with:',
                '  - notes = summary of what was verified',
                '  - passed = true (all criteria met) or false (something failed)',
            ].join('\n');
    }
}

function formatStatus(state: DesignState): string {
    const phase = activePhase(state);
    const done = state.phases.filter(p => p.status === 'complete').length;
    const total = state.phases.length;

    const lines: string[] = [
        `## ${state.project} [${done}/${total}]`,
        `> ${state.description}`,
        '',
    ];

    if (!phase || done === total) {
        lines.push('✅ All phases complete!');
    } else {
        lines.push(`**Current → Phase ${phase.number}/${total}: ${phase.name}** [${phase.status} / ${STAGE_LABEL[phase.stage]}]`);
        lines.push(phase.description);
        if (phase.specPath) lines.push(`Spec: \`${phase.specPath}\``);
        if (phase.criteria.length > 0) {
            lines.push('', '**Criteria:**');
            for (const c of phase.criteria) lines.push(`- ${c}`);
        }
        if (phase.log?.length) {
            lines.push('', '**Log:**');
            for (const l of phase.log.slice(-5)) lines.push(`  ${l}`);
        }
    }

    lines.push('', '**Phases:**');
    for (const p of state.phases) {
        const icon = p.status === 'complete' ? '✓' : p.status === 'in_progress' ? '→' : p.status === 'blocked' ? '✗' : '○';
        const stageTag = p.status === 'in_progress' ? ` [${STAGE_LABEL[p.stage]}]` : '';
        lines.push(`  ${icon} ${p.number}. ${p.name} [${p.status}]${stageTag}`);
    }

    return lines.join('\n');
}

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });

// ── Schema constants (extracted to avoid TS2589 deep instantiation) ──────────

const phaseInputSchema = z.object({
    name: z.string().describe('Short phase name'),
    description: z.string().describe('What to build in this phase'),
    criteria: z.array(z.string()).describe('Verifiable completion criteria'),
});

// ── MCP Server ────────────────────────────────────────────────────────────────

const srv = new McpServer({
    name: '@backendkit-labs/mcp-design',
    version: '0.1.0',
});

// ---------------------------------------------------------------------------
// design_init
// ---------------------------------------------------------------------------
// @ts-expect-error: TS2589 — MCP SDK + zod generic depth limit, safe at runtime
srv.tool(
    'design_init',
    'Initialize the spec-driven design roadmap for a project. Each phase follows: spec → implement → verify.',
    {
        cwd: z.string().describe('Absolute path to the project directory'),
        name: z.string().describe('Project name (short, human-readable)'),
        description: z.string().describe('High-level description of what the project does'),
        phases: z.array(phaseInputSchema).min(1).describe('Ordered list of development phases'),
    },
    async (args) => {
        const { cwd, name, description, phases } = args as {
            cwd: string;
            name: string;
            description: string;
            phases: Array<{ name: string; description: string; criteria: string[] }>;
        };
        const store = new DesignStore(cwd);
        if (store.exists()) {
            const existing = store.read();
            const done = existing.phases.filter(p => p.status === 'complete').length;
            return ok(`Design already exists (phase ${existing.currentPhase}/${existing.phases.length}, ${done} complete). Use design_status or design_edit.`);
        }
        const today = now();
        const state: DesignState = {
            project: name,
            cwd,
            description,
            createdAt: today,
            updatedAt: today,
            currentPhase: 1,
            phases: phases.map((p, i) => ({
                number: i + 1,
                name: p.name,
                description: p.description,
                criteria: p.criteria,
                status: (i === 0 ? 'in_progress' : 'pending') as PhaseStatus,
                stage: 'spec' as PhaseStage,
                ...(i === 0 ? { startedAt: today } : {}),
            })),
        };
        store.write(state);
        return ok(`Design initialized.\n\n${formatStatus(state)}\n\nCall design_next to begin Phase 1.`);
    },
);

// ---------------------------------------------------------------------------
// design_status
// ---------------------------------------------------------------------------
srv.tool(
    'design_status',
    'Show the current design state and phase progress for a project.',
    {
        cwd: z.string().describe('Absolute path to the project directory'),
    },
    async ({ cwd }) => {
        const store = new DesignStore(cwd);
        if (!store.exists()) return ok('No design initialized. Use design_init first.');
        return ok(formatStatus(store.read()));
    },
);

// ---------------------------------------------------------------------------
// design_next
// ---------------------------------------------------------------------------
srv.tool(
    'design_next',
    'Get the next task to work on. Returns stage-specific instructions (spec / implement / verify). Marks the phase in_progress if pending.',
    {
        cwd: z.string().describe('Absolute path to the project directory'),
    },
    async ({ cwd }) => {
        const store = new DesignStore(cwd);
        if (!store.exists()) return ok('No design initialized. Use design_init first.');
        const state = store.read();
        const done = state.phases.filter(p => p.status === 'complete').length;
        if (done === state.phases.length) return ok('✅ All phases complete! Project finished.');
        const phase = activePhase(state);
        if (!phase) return ok('✅ All phases complete! Project finished.');
        if (phase.status === 'pending') {
            phase.status = 'in_progress';
            phase.startedAt = now();
            store.write(state);
        }
        return ok(stageInstructions(phase, state.phases.length));
    },
);

// ---------------------------------------------------------------------------
// design_advance
// ---------------------------------------------------------------------------
// @ts-expect-error: TS2589 — MCP SDK + zod generic depth limit, safe at runtime
srv.tool(
    'design_advance',
    [
        'Advance the current phase stage: spec → implement → verify → next phase.',
        'In spec/implement stages: notes summarize what was produced; passed is ignored.',
        'In verify stage: passed=true completes the phase; passed=false blocks it back to implement.',
    ].join(' '),
    {
        cwd: z.string().describe('Absolute path to the project directory'),
        notes: z.string().describe('Summary of what was produced or verified in this stage'),
        passed: z.boolean().optional().describe('Required only in verify stage. true=phase complete, false=blocked'),
        specPath: z.string().optional().describe('Path to the spec document (only used in spec stage)'),
    },
    async ({ cwd, notes, passed, specPath }) => {
        const store = new DesignStore(cwd);
        if (!store.exists()) return ok('No design initialized.');
        const state = store.read();
        const phase = activePhase(state);
        if (!phase) return ok('All phases already complete.');
        const entry = `[${ts()}] ${STAGE_LABEL[phase.stage]}: ${notes}`;
        phase.log = phase.log ?? [];
        phase.log.push(entry);

        switch (phase.stage) {
            case 'spec': {
                if (specPath) phase.specPath = specPath;
                phase.stage = 'implement';
                store.write(state);
                return ok(`Spec recorded ✓\n\n➜ Moving to IMPLEMENT stage.\n\n${stageInstructions(phase, state.phases.length)}`);
            }
            case 'implement': {
                phase.stage = 'verify';
                store.write(state);
                return ok(`Implementation noted ✓\n\n➜ Moving to VERIFY stage.\n\n${stageInstructions(phase, state.phases.length)}`);
            }
            case 'verify': {
                if (passed === undefined) {
                    return ok('In verify stage, you must provide passed=true or passed=false.');
                }
                if (passed) {
                    phase.status = 'complete';
                    phase.completedAt = now();
                    const next = state.phases.find(p => p.number === phase.number + 1);
                    if (next) {
                        state.currentPhase = next.number;
                        next.status = 'in_progress';
                        next.startedAt = now();
                        store.write(state);
                        return ok(`Phase ${phase.number} complete ✓\n\n➜ Phase ${next.number}: ${next.name}\nCall design_next to start.`);
                    } else {
                        state.currentPhase = phase.number + 1;
                        store.write(state);
                        return ok(`Phase ${phase.number} complete ✓\n\n✅ All phases done! Project complete.`);
                    }
                } else {
                    phase.status = 'blocked';
                    phase.stage = 'implement';
                    store.write(state);
                    return ok(`Phase ${phase.number} BLOCKED ✗\nVerification failed: ${notes}\n\nFixed back to IMPLEMENT stage. Address the issues, then call design_advance again.`);
                }
            }
        }
    },
);

// ---------------------------------------------------------------------------
// design_edit
// ---------------------------------------------------------------------------
// @ts-expect-error: TS2589 — MCP SDK + zod generic depth limit, safe at runtime
srv.tool(
    'design_edit',
    'Edit a phase — update description, criteria, spec path, or force a stage/status change.',
    {
        cwd: z.string().describe('Absolute path to the project directory'),
        phase: z.number().describe('Phase number to edit (1-based)'),
        description: z.string().optional().describe('New description'),
        criteria: z.array(z.string()).optional().describe('New criteria (replaces existing)'),
        specPath: z.string().optional().describe('Path to the spec document'),
        stage: z.string().optional().describe('Force stage: spec | implement | verify'),
        status: z.string().optional().describe('Force status: pending | in_progress | complete | blocked'),
    },
    async (args) => {
        const { cwd, phase: phaseNum, description, criteria, specPath, stage, status } = args as {
            cwd: string;
            phase: number;
            description?: string;
            criteria?: string[];
            specPath?: string;
            stage?: PhaseStage;
            status?: PhaseStatus;
        };
        const store = new DesignStore(cwd);
        if (!store.exists()) return ok('No design initialized.');
        const state = store.read();
        const phase = state.phases.find(p => p.number === phaseNum);
        if (!phase) return ok(`Phase ${phaseNum} not found.`);
        if (description !== undefined) phase.description = description;
        if (criteria !== undefined) phase.criteria = criteria;
        if (specPath !== undefined) phase.specPath = specPath;
        if (stage !== undefined) phase.stage = stage;
        if (status !== undefined) phase.status = status;
        store.write(state);
        return ok(`Phase ${phaseNum} updated.\n\n${formatStatus(state)}`);
    },
);

// ---------------------------------------------------------------------------
// design_overview
// ---------------------------------------------------------------------------
srv.tool(
    'design_overview',
    'Show the spec-driven design status of all known projects.',
    {
        appName: z.string().optional().describe('App name (defaults to BK_APP_NAME or "bk-agent")'),
    },
    async ({ appName }) => {
        const projects = DesignStore.listAll(appName ?? APP_NAME);
        if (projects.length === 0) return ok('No design projects found.');
        const lines = ['## Design Overview', ''];
        for (const p of projects) {
            if (!p.state) { lines.push(`- ${p.key} — (no design.json)`); continue; }
            const s = p.state;
            const done = s.phases.filter(ph => ph.status === 'complete').length;
            const total = s.phases.length;
            const current = s.phases.find(ph => ph.number === s.currentPhase);
            const allDone = done === total;
            const icon = allDone ? '✅' : current?.status === 'blocked' ? '✗' : '→';
            const stageTag = current && !allDone ? ` / ${STAGE_LABEL[current.stage]}` : '';
            const phaseInfo = allDone ? 'complete' : current ? `Phase ${current.number}: ${current.name} [${current.status}${stageTag}]` : '';
            lines.push(`${icon} **${s.project}** [${done}/${total}]  ${phaseInfo}`);
        }
        return ok(lines.join('\n'));
    },
);

// ── Start ─────────────────────────────────────────────────────────────────────

async function main() {
    const transport = new StdioServerTransport();
    await srv.connect(transport);
    process.stderr.write(`[mcp-design] Running (app=${APP_NAME})\n`);
}

main().catch(e => {
    process.stderr.write(`[mcp-design] Fatal: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
});
