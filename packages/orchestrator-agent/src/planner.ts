import type { AgentConfig } from './config.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SubTask {
    id:             string;
    agent_id:       string;
    task:           string;
    depends_on:     string[];
    gate?:          boolean;    // pause for human approval after this step (set by config, not LLM)
    gate_criteria?: string[];
}

export interface TaskPlan {
    summary:   string;
    subtasks:  SubTask[];
}

// ── Prompt ────────────────────────────────────────────────────────────────────

const PLANNER_SYSTEM = `You are a task decomposition expert.
Given a task and a list of available specialist agents, produce a JSON execution plan.

Output ONLY valid JSON — no markdown, no explanation:
{
  "summary": "one-line description of the overall plan",
  "subtasks": [
    {
      "id": "t1",
      "agent_id": "agent-id-from-list",
      "task": "specific, actionable instruction for this specialist",
      "depends_on": [],
      "gate": false,
      "gate_criteria": []
    }
  ]
}

Rules:
- Use only agent IDs from the provided list.
- depends_on: [] means the sub-task can start immediately; ["t1"] waits for t1 to finish.
- If no agent matches a needed capability, use agent_id="unresolved" and note the gap.
- Keep each task description focused and self-contained.
- gate: set to true when a MANDATORY GATES section is present and the step's agent domain matches a governed domain. Always false otherwise.
- gate_criteria: when gate is true, copy the suggested criteria from the MANDATORY GATES section verbatim and add any task-specific criteria that the human approver should verify.`;

// ── TaskPlanner ───────────────────────────────────────────────────────────────

export class TaskPlanner {
    constructor(
        private readonly callLLM: (system: string, user: string) => Promise<string>,
    ) {}

    async plan(
        task:          string,
        agents:        AgentConfig[],
        vaultContext?: string,
        policyContext?: string,
    ): Promise<TaskPlan> {
        const agentList = agents
            .map(a => {
                const lines = [
                    `- id: ${a.id}`,
                    `  name: ${a.name}`,
                    `  capabilities: [${a.capabilities.join(', ')}]`,
                ];
                if (a.domain) lines.push(`  domain: ${a.domain}`);
                return lines.join('\n');
            })
            .join('\n');

        const contextBlock = vaultContext
            ? `\nKnowledge base context (use to inform the plan):\n${vaultContext}\n`
            : '';

        const policyBlock = policyContext
            ? `\n${policyContext}\n`
            : '';

        const user = [
            `Task: ${task}`,
            contextBlock,
            policyBlock,
            'Available agents:',
            agentList,
            '',
            'Produce the execution plan as JSON.',
        ].filter(Boolean).join('\n');

        const raw = await this.callLLM(PLANNER_SYSTEM, user);
        return this.parse(raw);
    }

    private parse(raw: string): TaskPlan {
        const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/) ?? raw.match(/(\{[\s\S]*\})/);
        const jsonStr   = jsonMatch ? jsonMatch[1].trim() : raw.trim();
        try {
            const plan = JSON.parse(jsonStr) as TaskPlan;
            this.validate(plan);
            return plan;
        } catch (err) {
            throw new Error(
                `TaskPlanner: could not parse plan.\nRaw output: ${raw.slice(0, 500)}\nError: ${String(err)}`
            );
        }
    }

    private validate(plan: TaskPlan): void {
        if (!plan.summary || !Array.isArray(plan.subtasks)) {
            throw new Error('Plan missing required fields: summary, subtasks');
        }
        for (const st of plan.subtasks) {
            if (!st.id || !st.agent_id || !st.task || !Array.isArray(st.depends_on)) {
                throw new Error(`Sub-task malformed: ${JSON.stringify(st)}`);
            }
        }
        const ids = new Set(plan.subtasks.map(s => s.id));
        for (const st of plan.subtasks) {
            for (const dep of st.depends_on) {
                if (!ids.has(dep)) throw new Error(`Sub-task ${st.id} depends on unknown id: ${dep}`);
            }
        }
    }
}
