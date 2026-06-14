# Gates and Policy Rules

Gates pause execution after a step and wait for a human to review the agent's output and approve or reject it. There are two ways gates are triggered: explicit configuration and automatic policy rules (Cable 2).

## Explicit gates

Set `gate: true` on an agent or a flow step. After the agent completes its task, execution pauses and waits for `orchestrator_approve`.

### On an agent (applies to all plans that use this agent)

```yaml
agents:
  - id: legal-agent
    name: Legal Specialist
    description: Reviews contracts and compliance
    capabilities: [contracts, compliance]
    provider: local
    gate: true
    gate_criteria:
      - "Contract complies with current labor regulations"
      - "Confidentiality clauses are appropriate for the role"
      - "No irregular or risky clauses detected"
```

### On a flow step (applies to this step only)

```yaml
steps:
  - id: s1-hr-checklist
    agent: hr-agent
    task: "Prepare onboarding checklist for {{payload.nombre}}"
    depends_on: []
    gate: true
    gate_criteria:
      - "Employee data is complete and correct"
      - "Documentation checklist is appropriate for the role"
```

### In a dynamic plan (LLM decides)

When dynamic planning is used, the LLM sets `gate: true` in the generated plan based on:
- The `gate: true` setting on the agent config
- Active policy rules injected into the planner prompt (Milestone 3 / Cable 1)
- Its own judgment about steps that need human review

## Gate approval workflow

```
1. orchestrator_run → runId (status: running)
2. orchestrator_status → status: waiting_gate
   {
     waitingGate: {
       stepId: "s1-hr-checklist",
       agentId: "hr-agent",
       output: "...",           ← full agent output for review
       criteria: ["...", "..."] ← checklist from gate_criteria
     }
   }
3. Human reviews output against criteria
4. orchestrator_approve(approved: true/false, notes: "...")
5. If approved: execution resumes from the next step
   If rejected: run is marked failed, no further steps execute
```

## Automatic gates — Cable 2

Policy rules (stored in `manifest.yaml`) are enforced automatically **before** any matching step runs. This is Cable 2: deterministic, no LLM involved.

When a step matches an active policy rule:
- The step **still runs** (gates check the *output*, not whether to run)
- After the step completes, a gate is automatically required
- The gate criteria include the rule's requirements

This means a step can be gated even without `gate: true` in the config, if a matching rule exists.

### How rules match steps

A rule matches a step when:
- The agent has `domain:` set **and** it matches the rule's `if.domain`
- **And/or** the task text contains keywords from `if.keywords`

```yaml
# manifest.yaml (auto-managed by orchestrator_reflect_promote)
policyRules:
  - id: rule-001
    name: "HR data must be validated before onboarding"
    trigger:
      domain: rrhh
      pattern: data-validation
      minOccurrences: 3
    if:
      domain: rrhh
      keywords: [onboarding, datos, empleado]
    then:
      mustInclude: ["checklist de documentación", "datos verificados"]
      requireArchitectureReview: false
```

### Rule `then` actions

| Field | Description |
|-------|-------------|
| `mustInclude` | Criteria text shown to approver: "Must include: ..." |
| `mustPass` | Criteria text: "Must pass: ..." |
| `mustExecute` | Criteria text: "Must execute: ..." |
| `requireArchitectureReview` | Adds "Requires architecture review" criterion |
| `requireSecurityReview` | Adds "Requires security review" criterion |
| `requireQaApproval` | Adds "Requires QA approval" criterion |

## Gate outcome recording (Cable 1)

When a gate is approved or rejected, the reflection system records the outcome:
- **Approved** → `success` for all applied rule IDs
- **Rejected** → `failure` for all applied rule IDs

These outcomes feed the MAPE-K loop — rules with too many failures become demotion candidates. See [Enterprise Reflection](reflection.md).

## Multiple gates in one run

If a plan has multiple gated steps:

- If two parallel steps both need gates, the **first** one (by array order) fires immediately
- The second appears as a new gate on the **next resume cycle** (after the first is approved)
- Each approval resumes execution and runs until the next gate

```
Step A [GATE] ──┐
Step B [GATE] ──┘  ← run in parallel
                    ↓
                Gate A fires → user approves
                    ↓
                Gate B fires → user approves
                    ↓
                Step C (no gate)
```

## Tips

- Set `gate: true` on agents that touch sensitive data (HR, legal, finance)
- Write `gate_criteria` as verification questions, not instructions
- Use `notes` in `orchestrator_approve` to build an audit trail — notes are stored in the run record
- `waiting_gate` runs survive server restarts — `orchestrator_list_runs(status: waiting_gate)` finds them
- Policy rules (Cable 2) override explicit config: if a rule matches, the gate fires regardless of `gate: false` in the agent config
