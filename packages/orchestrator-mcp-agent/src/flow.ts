import * as fs   from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'yaml';
import { z }     from 'zod';

// ── Flow schema ───────────────────────────────────────────────────────────────

const FlowStepSchema = z.object({
    id:             z.string(),
    agent:          z.string(),
    task:           z.string(),
    capability:     z.string().optional(),
    input:          z.record(z.unknown()).optional(),
    depends_on:     z.array(z.string()).default([]),
    gate:           z.boolean().optional(),
    gate_criteria:  z.array(z.string()).optional(),
    required:       z.boolean().optional(),        // if true, flow pauses on failure until orchestrator_retry
});

const FlowSchema = z.object({
    version:     z.number().default(2),
    id:          z.string(),
    name:        z.string(),
    description: z.string().optional(),
    steps:       z.array(FlowStepSchema).min(1),
});

export type Flow     = z.infer<typeof FlowSchema>;
export type FlowStep = z.infer<typeof FlowStepSchema>;

// ── Loader ────────────────────────────────────────────────────────────────────

export function loadFlow(flowPath: string): Flow {
    const resolved = path.resolve(flowPath);
    if (!fs.existsSync(resolved)) throw new Error(`Flow file not found: ${resolved}`);

    const raw    = yaml.parse(fs.readFileSync(resolved, 'utf-8')) as unknown;
    const result = FlowSchema.safeParse(raw);
    if (!result.success) {
        const issues = result.error.issues.map(i => `  ${i.path.join('.')}: ${i.message}`).join('\n');
        throw new Error(`Invalid flow ${path.basename(flowPath)}:\n${issues}`);
    }
    return result.data;
}

// ── Router ────────────────────────────────────────────────────────────────────

export function matchFlow(
    entries:   { id: string; file: string; trigger?: string }[],
    configDir: string,
    task:      string,
): { id: string; flow: Flow } | null {
    for (const entry of entries) {
        if (!entry.trigger) continue;
        if (new RegExp(entry.trigger, 'i').test(task)) {
            const flow = loadFlow(path.resolve(configDir, entry.file));
            return { id: entry.id, flow };
        }
    }
    return null;
}
