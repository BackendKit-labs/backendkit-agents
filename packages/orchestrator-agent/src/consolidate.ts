import type { ExecutionResult } from './executor.js';
import { VaultWriter } from '@backendkit-labs/agent-enterprise';

const CONSOLIDATION_SYSTEM = `You are a knowledge consolidation system. Extract reusable learnings from multi-agent run outputs.
- Write 1-3 concrete, reusable facts or patterns that would help future agents handling similar tasks.
- Focus on what worked, discoveries, edge cases found, or non-obvious domain knowledge.
- If this is a routine execution with nothing new or reusable, respond with exactly: NOTHING_TO_CONSOLIDATE
- Write in the same language as the content. Use brief markdown bullets or short sections.`;

/**
 * Distills reusable learnings from a completed run into the vault.
 * Uses the orchestrator LLM to decide what's worth consolidating — routine
 * executions return undefined without writing anything.
 */
export async function consolidateRun(
    runId:      string,
    task:       string,
    steps:      ExecutionResult[],
    callLLMFn:  (system: string, user: string) => Promise<string>,
    vaultWriter: VaultWriter,
): Promise<string | undefined> {
    const successSteps = steps.filter(s => s.success);
    if (successSteps.length === 0) return undefined;

    const stepsText = successSteps
        .map(s => `[${s.agent_id}] Task: ${s.task}\nOutput: ${s.result.slice(0, 600)}`)
        .join('\n\n---\n\n');

    const distilled = await callLLMFn(
        CONSOLIDATION_SYSTEM,
        `Task: ${task}\n\nAgent outputs:\n\n${stepsText}`,
    ).catch(() => null);

    if (!distilled || distilled.trim().startsWith('NOTHING_TO_CONSOLIDATE')) return undefined;

    return vaultWriter.writeNote({
        title:       `Aprendizaje — ${task.slice(0, 60)}`,
        content:     distilled,
        agentId:     'orchestrator',
        tags:        ['área/orquestador', 'función/aprendizaje', 'auto-consolidado'],
        description: `Run ${runId}: ${task.slice(0, 100)}`,
    }).catch(() => undefined);
}
