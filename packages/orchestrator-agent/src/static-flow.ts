import * as fs   from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';
import { z }     from 'zod';
import type { TaskPlan, SubTask } from './planner.js';

// ── Schema ────────────────────────────────────────────────────────────────────

const FlowStepSchema = z.object({
    id:             z.string(),
    agent:          z.string(),
    task:           z.string(),
    depends_on:     z.array(z.string()).default([]),
    gate:           z.boolean().optional(),
    gate_criteria:  z.array(z.string()).optional(),
});

const StaticFlowSchema = z.object({
    version:     z.number().default(1),
    id:          z.string(),
    name:        z.string(),
    description: z.string().optional(),
    steps:       z.array(FlowStepSchema).min(1),
});

export type StaticFlow = z.infer<typeof StaticFlowSchema>;
export type FlowStep   = z.infer<typeof FlowStepSchema>;

// ── Flow config entry (in orchestrator.yaml) ──────────────────────────────────

export const FlowEntrySchema = z.object({
    id:      z.string(),
    file:    z.string(),                           // path relative to orchestrator.yaml
    trigger: z.string().optional(),                // regex to match task descriptions
});

export type FlowEntry = z.infer<typeof FlowEntrySchema>;

// ── Loader ────────────────────────────────────────────────────────────────────

export function loadFlow(flowPath: string): StaticFlow {
    const resolved = path.resolve(flowPath);
    if (!fs.existsSync(resolved)) {
        throw new Error(`Flow file not found: ${resolved}`);
    }
    const raw    = yaml.parse(fs.readFileSync(resolved, 'utf-8')) as unknown;
    const result = StaticFlowSchema.safeParse(raw);
    if (!result.success) {
        const issues = result.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n');
        throw new Error(`Invalid flow file ${path.basename(flowPath)}:\n${issues}`);
    }
    return result.data;
}

// ── Router ────────────────────────────────────────────────────────────────────

/**
 * Find the first flow whose trigger regex matches the task description.
 * Returns null if no flow matches → fall back to TaskPlanner.
 */
export function matchFlow(
    entries: FlowEntry[],
    configDir: string,
    task: string,
): { entry: FlowEntry; flow: StaticFlow } | null {
    for (const entry of entries) {
        if (!entry.trigger) continue;
        const regex = new RegExp(entry.trigger, 'i');
        if (regex.test(task)) {
            const flowPath = path.resolve(configDir, entry.file);
            const flow     = loadFlow(flowPath);
            return { entry, flow };
        }
    }
    return null;
}

// ── Converter ─────────────────────────────────────────────────────────────────

/**
 * Convert a static flow definition to a TaskPlan, interpolating
 * {{payload.key}} placeholders with values from the provided payload.
 */
export function flowToTaskPlan(flow: StaticFlow, payload: Record<string, string> = {}): TaskPlan {
    const subtasks: SubTask[] = flow.steps.map(step => ({
        id:            step.id,
        agent_id:      step.agent,
        task:          interpolate(step.task, payload),
        depends_on:    step.depends_on,
        gate:          step.gate,
        gate_criteria: step.gate_criteria?.map(c => interpolate(c, payload)),
    }));

    return {
        summary: interpolate(flow.name, payload),
        subtasks,
    };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function interpolate(template: string, payload: Record<string, string>): string {
    return template.replace(/\{\{payload\.(\w+)\}\}/g, (_, key: string) => payload[key] ?? `{{payload.${key}}}`);
}
