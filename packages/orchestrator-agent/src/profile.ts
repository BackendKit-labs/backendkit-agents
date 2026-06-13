import type { AgentProfile } from '@backendkit-labs/agent-core';
import type { OrchestratorConfig } from './config.js';

// Builds the orchestrator's AgentProfile dynamically from orchestrator.yaml.
// The system prompt is generated from configured agents — not hardcoded.

export function buildOrchestratorProfile(config: OrchestratorConfig): AgentProfile {
    const agentList = config.agents
        .map(a => `  - ${a.id} (${a.name}): ${a.description}\n    capabilities: [${a.capabilities.join(', ')}]`)
        .join('\n');

    const systemPrompt = [
        `You are ${config.orchestrator.name}, an intelligent task orchestrator.`,
        '',
        'Your responsibilities:',
        '1. Understand the user\'s request and identify which specialists are needed.',
        '2. Search the shared knowledge vault with search_knowledge for relevant context.',
        '3. Delegate each part of the task to the appropriate specialist via ask_agent.',
        '4. For independent tasks, you can call ask_agent multiple times.',
        '5. Consolidate all results into a coherent, actionable final answer.',
        '',
        'Available specialists:',
        agentList,
        '',
        'Rules:',
        '- Always search the vault before delegating — existing decisions should guide the plan.',
        '- Never execute domain work yourself — delegate everything to specialists.',
        '- If a task requires capabilities no agent has, say so explicitly.',
        '- Cite specialist results in your final answer.',
    ].join('\n');

    return {
        id:           'orchestrator',
        name:         config.orchestrator.name,
        icon:         '◆',
        description:  'Dynamic task orchestrator — routes and coordinates configured specialist agents.',
        systemPrompt,
        allowedTools: ['search_knowledge', 'ask_agent'],
        delegatesTo:  config.agents.map(a => a.id),
    };
}
