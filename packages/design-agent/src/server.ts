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
// Co-located with ProjectStore: ~/.{appName}/projects/{key}/design.json

class DesignStore {
    readonly projectDir: string;
    private readonly statePath: string;

    constructor(cwd: string, appName = APP_NAME) {
        const key = cwdToProjectKey(cwd);
        this.projectDir = join(homedir(), `.${appName}`, 'projects', key);
        this.statePath = join(this.projectDir, 'design.json');
        mkdirSync(this.projectDir, { recursive: true });
    }

    exists(): boolean { return existsSync(this.statePath); }

    read(): DesignState {
        return JSON.parse(readFileSync(this.statePath, 'utf-8')) as DesignState;
    }

    write(state: DesignState): void {
        state.updatedAt = new Date().toISOString().slice(0, 10);
        writeFileSync(this.statePath, JSON.stringify(state, null, 2), 'utf-8');
    }

    static listAll(appName = APP_NAME): Array<{ key: string; state?: DesignState }> {
        const base = join(homedir(), `.${appName}`, 'projects');
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
            })
            .filter(p => p.state !== undefined);
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

function stageInstructions(phase: Phase, total: number): string {
    const header = `**Phase ${phase.number}/${total}: ${phase.name}** — ${STAGE_LABEL[phase.stage]}`;
    const criteria = phase.criteria.length
        ? '\n\n**Criteria to satisfy:**\n' + phase.criteria.map(c => `- [ ] ${c}`).join('\n')
        : '';
    switch (phase.stage) {
        case 'spec':
            return [
                header, '', phase.description, criteria, '',
                '**Your task (SPEC stage):**',
                '1. Write formal interfaces, types, and API contracts for this phase.',
                '2. Write test cases or acceptance scenarios that define "done".',
                `3. Save the spec to \`docs/spec-phase${phase.number}.md\` (or equivalent).`,
                '',
                'When spec is written, call `design_advance` with notes="path/to/spec.md".',
            ].join('\n');
        case 'implement':
            return [
                header, '', phase.description,
                phase.specPath ? `\n**Spec:** \`${phase.specPath}\` — implement to satisfy this spec.` : '',
                criteria, '',
                '**Your task (IMPLEMENT stage):**',
                '1. Write code that satisfies the spec and criteria above.',
                '2. Follow the contracts defined in the spec document.',
                '',
                'When ready for testing, call `design_advance` with notes summarizing what you built.',
            ].join('\n');
        case 'verify':
            return [
                header, '', phase.description,
                phase.specPath ? `\n**Spec:** \`${phase.specPath}\`` : '',
                criteria, '',
                '**Your task (VERIFY stage):**',
                '1. Run tests, type checks, and linting.',
                '2. Verify each criterion is satisfied.',
                '3. Confirm implementation matches the spec.',
                '',
                'Call `design_advance` with notes=summary and passed=true or false.',
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
        if (phase.criteria.length) {
            lines.push('', '**Criteria:**');
            for (const c of phase.criteria) lines.push(`- ${c}`);
        }
        if (phase.log?.length) {
            lines.push('', '**Log (last 5):**');
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

function buildRoadmapMd(state: DesignState): string {
    const lines = [
        `# ROADMAP — ${state.project}`,
        '',
        `> ${state.description}`,
        '',
        `Created: ${state.createdAt}`,
        '',
        '---',
        '',
    ];
    for (const p of state.phases) {
        lines.push(`## Phase ${p.number}: ${p.name}`, '');
        lines.push(p.description);
        if (p.criteria.length) {
            lines.push('', '**Completion criteria:**');
            for (const c of p.criteria) lines.push(`- [ ] ${c}`);
        }
        lines.push('', '---', '');
    }
    return lines.join('\n');
}

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] });

const phaseInputSchema = z.object({
    name: z.string().describe('Short phase name'),
    description: z.string().describe('What to build in this phase'),
    criteria: z.array(z.string()).describe('Verifiable completion criteria'),
});

// ── MCP Server ────────────────────────────────────────────────────────────────

const srv = new McpServer({
    name: '@backendkit-labs/design-agent',
    version: '0.2.0',
});

// ---------------------------------------------------------------------------
// design_save_prompt — writes prompt.md to cwd (replaces /prompt)
// ---------------------------------------------------------------------------
// @ts-ignore
srv.tool(
    'design_save_prompt',
    'Save the structured project prompt/requirements to prompt.md in the project directory.',
    {
        cwd: z.string().describe('Absolute path to the project directory'),
        content: z.string().describe('The structured prompt content to save'),
    },
    async ({ cwd, content }) => {
        writeFileSync(join(cwd, 'prompt.md'), content, 'utf-8');
        return ok(`prompt.md saved to ${cwd}`);
    },
);

// ---------------------------------------------------------------------------
// design_save_docs — writes specification.md, design.md, AGENT.md to cwd (replaces /init doc creation)
// ---------------------------------------------------------------------------
// @ts-ignore
srv.tool(
    'design_save_docs',
    'Save specification and/or design documents to the project directory. Call after the agent generates content from the prompt.',
    {
        cwd: z.string().describe('Absolute path to the project directory'),
        specification: z.string().optional().describe('Content for specification.md'),
        design: z.string().optional().describe('Content for design.md'),
        agentMd: z.string().optional().describe('Content for AGENT.md (project-specific agent instructions)'),
    },
    async ({ cwd, specification, design, agentMd }) => {
        const saved: string[] = [];
        if (specification) { writeFileSync(join(cwd, 'specification.md'), specification, 'utf-8'); saved.push('specification.md'); }
        if (design)         { writeFileSync(join(cwd, 'design.md'), design, 'utf-8');              saved.push('design.md'); }
        if (agentMd)        { writeFileSync(join(cwd, 'AGENT.md'), agentMd, 'utf-8');              saved.push('AGENT.md'); }
        if (!saved.length)  return ok('No content provided. Pass at least one of: specification, design, agentMd.');
        return ok(`Saved: ${saved.join(', ')} → ${cwd}`);
    },
);

// ---------------------------------------------------------------------------
// design_read_context — reads all design docs from cwd + execution state
// ---------------------------------------------------------------------------
// @ts-ignore
srv.tool(
    'design_read_context',
    'Read all design documents from the project directory (prompt.md, specification.md, design.md, AGENT.md, ROADMAP.md) and the current execution state.',
    {
        cwd: z.string().describe('Absolute path to the project directory'),
    },
    async ({ cwd }) => {
        const files = ['prompt.md', 'specification.md', 'design.md', 'AGENT.md', 'ROADMAP.md'];
        const parts: string[] = [];
        for (const f of files) {
            try {
                const content = readFileSync(join(cwd, f), 'utf-8').trim();
                if (content) parts.push(`## ${f}\n\n${content}`);
            } catch { /* not present */ }
        }
        const store = new DesignStore(cwd);
        if (store.exists()) parts.push(`## Execution State\n\n${formatStatus(store.read())}`);
        if (!parts.length) return ok('No design documents found in this directory.');
        return ok(parts.join('\n\n---\n\n'));
    },
);

// ---------------------------------------------------------------------------
// design_init — creates execution state + ROADMAP.md
// ---------------------------------------------------------------------------
// @ts-ignore
srv.tool(
    'design_init',
    'Initialize the spec-driven execution roadmap. Saves design.json to ~/.{appName}/projects/{key}/ and writes ROADMAP.md to the project cwd.',
    {
        cwd: z.string().describe('Absolute path to the project directory'),
        name: z.string().describe('Project name'),
        description: z.string().describe('High-level description'),
        phases: z.array(phaseInputSchema).min(1).describe('Ordered development phases'),
    },
    async (args) => {
        const { cwd, name, description, phases } = args as {
            cwd: string; name: string; description: string;
            phases: Array<{ name: string; description: string; criteria: string[] }>;
        };
        const store = new DesignStore(cwd);
        if (store.exists()) {
            const ex = store.read();
            const done = ex.phases.filter(p => p.status === 'complete').length;
            return ok(`Design already initialized (phase ${ex.currentPhase}/${ex.phases.length}, ${done} complete). Use design_status or design_edit.`);
        }
        const today = now();
        const state: DesignState = {
            project: name, cwd, description,
            createdAt: today, updatedAt: today, currentPhase: 1,
            phases: phases.map((p, i) => ({
                number: i + 1, name: p.name, description: p.description, criteria: p.criteria,
                status: (i === 0 ? 'in_progress' : 'pending') as PhaseStatus,
                stage: 'spec' as PhaseStage,
                ...(i === 0 ? { startedAt: today } : {}),
            })),
        };
        store.write(state);
        writeFileSync(join(cwd, 'ROADMAP.md'), buildRoadmapMd(state), 'utf-8');
        return ok([
            `Design initialized.`,
            `  State  → ${store.projectDir}/design.json`,
            `  Roadmap → ${cwd}/ROADMAP.md`,
            '',
            formatStatus(state),
            '',
            'Call design_next to begin Phase 1.',
        ].join('\n'));
    },
);

// ---------------------------------------------------------------------------
// design_status
// ---------------------------------------------------------------------------
// @ts-ignore
srv.tool(
    'design_status',
    'Show the current execution state and phase progress.',
    { cwd: z.string().describe('Absolute path to the project directory') },
    async ({ cwd }) => {
        const store = new DesignStore(cwd);
        if (!store.exists()) return ok('No design initialized. Use design_init first.');
        return ok(formatStatus(store.read()));
    },
);

// ---------------------------------------------------------------------------
// design_next
// ---------------------------------------------------------------------------
// @ts-ignore
srv.tool(
    'design_next',
    'Get stage-specific instructions for the current phase (spec / implement / verify).',
    { cwd: z.string().describe('Absolute path to the project directory') },
    async ({ cwd }) => {
        const store = new DesignStore(cwd);
        if (!store.exists()) return ok('No design initialized. Use design_init first.');
        const state = store.read();
        const done = state.phases.filter(p => p.status === 'complete').length;
        if (done === state.phases.length) return ok('✅ All phases complete! Project finished.');
        const phase = activePhase(state);
        if (!phase) return ok('✅ All phases complete! Project finished.');
        if (phase.status === 'pending') { phase.status = 'in_progress'; phase.startedAt = now(); store.write(state); }
        return ok(stageInstructions(phase, state.phases.length));
    },
);

// ---------------------------------------------------------------------------
// design_advance
// ---------------------------------------------------------------------------
// @ts-ignore
srv.tool(
    'design_advance',
    'Advance the current phase stage: spec → implement → verify → next phase. In verify, passed=true completes the phase; passed=false blocks back to implement.',
    {
        cwd: z.string().describe('Absolute path to the project directory'),
        notes: z.string().describe('Summary of what was produced or verified'),
        passed: z.boolean().optional().describe('Only in verify stage. true=complete, false=blocked'),
        specPath: z.string().optional().describe('Spec document path (spec stage only)'),
    },
    async (args) => {
        const { cwd, notes, passed, specPath } = args as {
            cwd: string; notes: string; passed?: boolean; specPath?: string;
        };
        const store = new DesignStore(cwd);
        if (!store.exists()) return ok('No design initialized.');
        const state = store.read();
        const phase = activePhase(state);
        if (!phase) return ok('All phases already complete.');
        phase.log = phase.log ?? [];
        phase.log.push(`[${ts()}] ${STAGE_LABEL[phase.stage]}: ${notes}`);

        switch (phase.stage) {
            case 'spec':
                if (specPath) phase.specPath = specPath;
                phase.stage = 'implement';
                store.write(state);
                return ok(`Spec recorded ✓\n\n➜ IMPLEMENT stage.\n\n${stageInstructions(phase, state.phases.length)}`);
            case 'implement':
                phase.stage = 'verify';
                store.write(state);
                return ok(`Implementation noted ✓\n\n➜ VERIFY stage.\n\n${stageInstructions(phase, state.phases.length)}`);
            case 'verify':
                if (passed === undefined) return ok('In verify stage you must provide passed=true or passed=false.');
                if (passed) {
                    phase.status = 'complete'; phase.completedAt = now();
                    const next = state.phases.find(p => p.number === phase.number + 1);
                    if (next) {
                        state.currentPhase = next.number; next.status = 'in_progress'; next.startedAt = now();
                        store.write(state);
                        return ok(`Phase ${phase.number} complete ✓\n\n➜ Phase ${next.number}: ${next.name}\nCall design_next to start.`);
                    }
                    state.currentPhase = phase.number + 1;
                    store.write(state);
                    return ok(`Phase ${phase.number} complete ✓\n\n✅ All phases done! Project complete.`);
                }
                phase.status = 'blocked'; phase.stage = 'implement';
                store.write(state);
                return ok(`Phase ${phase.number} BLOCKED ✗\n${notes}\n\nReverted to IMPLEMENT. Fix and call design_advance again.`);
        }
    },
);

// ---------------------------------------------------------------------------
// design_edit
// ---------------------------------------------------------------------------
// @ts-ignore
srv.tool(
    'design_edit',
    'Edit a phase — update description, criteria, spec path, or force stage/status.',
    {
        cwd: z.string().describe('Absolute path to the project directory'),
        phase: z.number().describe('Phase number (1-based)'),
        description: z.string().optional(),
        criteria: z.array(z.string()).optional(),
        specPath: z.string().optional(),
        stage: z.string().optional().describe('spec | implement | verify'),
        status: z.string().optional().describe('pending | in_progress | complete | blocked'),
    },
    async (args) => {
        const { cwd, phase: phaseNum, description, criteria, specPath, stage, status } = args as {
            cwd: string; phase: number; description?: string; criteria?: string[];
            specPath?: string; stage?: PhaseStage; status?: PhaseStatus;
        };
        const store = new DesignStore(cwd);
        if (!store.exists()) return ok('No design initialized.');
        const state = store.read();
        const phase = state.phases.find(p => p.number === phaseNum);
        if (!phase) return ok(`Phase ${phaseNum} not found.`);
        if (description !== undefined) phase.description = description;
        if (criteria    !== undefined) phase.criteria    = criteria;
        if (specPath    !== undefined) phase.specPath    = specPath;
        if (stage       !== undefined) phase.stage       = stage;
        if (status      !== undefined) phase.status      = status;
        store.write(state);
        return ok(`Phase ${phaseNum} updated.\n\n${formatStatus(state)}`);
    },
);

// ---------------------------------------------------------------------------
// design_overview
// ---------------------------------------------------------------------------
// @ts-ignore
srv.tool(
    'design_overview',
    'Show spec-driven design status of all known projects.',
    { appName: z.string().optional().describe('App name (defaults to BK_APP_NAME or "bk-agent")') },
    async ({ appName }) => {
        const projects = DesignStore.listAll(appName ?? APP_NAME);
        if (!projects.length) return ok('No design projects found.');
        const lines = ['## Design Overview', ''];
        for (const p of projects) {
            if (!p.state) continue;
            const s = p.state;
            const done = s.phases.filter(ph => ph.status === 'complete').length;
            const total = s.phases.length;
            const current = s.phases.find(ph => ph.number === s.currentPhase);
            const allDone = done === total;
            const icon = allDone ? '✅' : current?.status === 'blocked' ? '✗' : '→';
            const stageTag = current && !allDone ? ` / ${STAGE_LABEL[current.stage]}` : '';
            const info = allDone ? 'complete' : current ? `Phase ${current.number}: ${current.name} [${current.status}${stageTag}]` : '';
            lines.push(`${icon} **${s.project}** [${done}/${total}]  ${info}`);
        }
        return ok(lines.join('\n'));
    },
);

// ── Start ─────────────────────────────────────────────────────────────────────

async function main() {
    const transport = new StdioServerTransport();
    await srv.connect(transport);
    process.stderr.write(`[design-agent] Running (app=${APP_NAME})\n`);
}

main().catch(e => {
    process.stderr.write(`[design-agent] Fatal: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
});
