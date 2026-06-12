import { z } from 'zod';

// ── Document taxonomy ─────────────────────────────────────────────────────────

export const AREAS = [
    'rrhh', 'finanzas', 'operaciones', 'ventas',
    'soporte', 'legal', 'calidad', 'general',
] as const;

export const DOC_TYPES = [
    'politica',       // rules enforced by the company
    'decision',       // a specific decision taken, with rationale
    'procedimiento',  // step-by-step process / runbook
    'leccion',        // lesson learned, post-mortem finding
    'norma_externa',  // external regulation, law, ISO standard
] as const;

export type Area    = (typeof AREAS)[number];
export type DocType = (typeof DOC_TYPES)[number];

// ── Curated note schema (validated before writing) ────────────────────────────

export const CuratedNoteSchema = z.object({
    /** Document type — determines template and required fields. */
    type: z.enum(DOC_TYPES),
    /** Target vault folder. */
    area: z.enum(AREAS),
    /** Descriptive, specific title. Good for exact-match search. */
    title: z.string().min(5).max(120),
    /**
     * 1-2 sentences dense with searchable terms: names, numbers, rules, dates.
     * This is the primary field used by semantic search — write it carefully.
     */
    resumen: z.string().min(10).max(300),
    /** Markdown body with ## sections. Extracted facts, not raw copy-paste. */
    content: z.string().min(20),
    /** Hierarchical tags: "área/<area>", "tipo/<type>", "estado/vigente", etc. */
    tags: z.array(z.string()),
    /** ISO date when the rule/policy became effective. Required for 'politica'. */
    vigente_desde: z.string().optional(),
    /** Policy/procedure version number. */
    version: z.number().int().positive().optional(),
    /** ISO date when this note should be reviewed or expires. */
    expires_at: z.string().optional(),
    /** People/roles that made this decision. Required for 'decision'. */
    decidido_por: z.array(z.string()).optional(),
    /** Departments or roles this applies to. */
    aplica_a: z.array(z.string()).optional(),
});

export type CuratedNote = z.infer<typeof CuratedNoteSchema>;

/** The JSON structure the LLM must return. */
export const CurationResponseSchema = z.object({
    notes: z.array(CuratedNoteSchema).min(1).max(5),
});

export type CurationResponse = z.infer<typeof CurationResponseSchema>;

// ── Runtime result ────────────────────────────────────────────────────────────

export interface CurationResult {
    notesWritten:  string[];   // absolute file paths
    notesSkipped:  string[];   // titles that already existed (dedup)
    errors:        string[];
    durationMs:    number;
}
