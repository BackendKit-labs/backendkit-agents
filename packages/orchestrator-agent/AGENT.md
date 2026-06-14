# orchestrator-agent

Config-driven multi-agent orchestration. Decomposes natural language tasks into dependency-ordered sub-tasks, routes each to the right specialist agent, enforces human approval gates, and persists every run to disk or Redis. All behavior is driven by `orchestrator.yaml` — no code changes needed to add agents or flows.

## MCP Tools

### `orchestrator_run`
Start a coordinated multi-agent task. Automatically selects a pre-defined static flow if the task matches one; otherwise the LLM generates a dynamic plan. Returns a `runId` immediately — execution runs in the background.

Parameters:
- `config_path` (string, required) — absolute path to `orchestrator.yaml`
- `task` (string, required) — task description in natural language
- `flow_id` (string, optional) — force a specific static flow by ID
- `payload` (object, optional) — key-value pairs for `{{payload.key}}` interpolation in static flows

### `orchestrator_status`
Get the current status of a run. Returns step progress, gate details (when waiting), or the final report (when complete).

Parameters:
- `config_path` (string, required)
- `run_id` (string, required) — returned by `orchestrator_run`

Status values: `running` | `waiting_gate` | `complete` | `failed`

### `orchestrator_approve`
Approve or reject a gate that paused a running orchestration. On approval, execution resumes automatically from the next pending step.

Parameters:
- `config_path` (string, required)
- `run_id` (string, required)
- `approved` (boolean, required) — `true` to resume, `false` to stop
- `notes` (string, optional) — required when rejecting; optional context when approving

### `orchestrator_list_runs`
List all persisted runs with status summary. Runs survive server restarts.

Parameters:
- `config_path` (string, required)
- `status` (enum, default `all`) — filter: `running` | `waiting_gate` | `complete` | `failed` | `all`
- `limit` (number, default 20) — max runs to return (most recent first)

### `orchestrator_list_agents`
List all specialist agents configured in `orchestrator.yaml` with their capabilities, providers, and gate settings.

Parameters:
- `config_path` (string, required)

### `orchestrator_reflect`
View enterprise reflection status: pending pattern promotions, active policy rules, and demotion candidates. Use this to understand what the system has learned from gate outcomes.

Parameters:
- `config_path` (string, required)

### `orchestrator_reflect_promote`
Approve or reject a pending pattern promotion. Approving writes a deterministic policy rule to `manifest.yaml` — enforced automatically on every matching step (no LLM involved, Cable 2).

Parameters:
- `config_path` (string, required)
- `promotion_id` (string, required) — format `"domain::failureType"`, copy from `orchestrator_reflect` output
- `approved` (boolean, required)
- `approver` (string, required) — name or email, written to audit trail
- `reason` (string, optional/required when rejecting)

### `orchestrator_reflect_demote`
Approve demotion of an active policy rule with a high failure rate. Removes it from `manifest.yaml` with a full audit trail.

Parameters:
- `config_path` (string, required)
- `rule_id` (string, required) — copy from `orchestrator_reflect` demotion candidates
- `approver` (string, required)
- `reason` (string, required)

## Typical usage pattern

```
# 1. Start a task
orchestrator_run → { runId: "run-1234-abc" }

# 2. Poll until not running
orchestrator_status(run_id) → { status: "waiting_gate", waitingGate: { criteria: [...] } }

# 3. Review gate output, approve or reject
orchestrator_approve(run_id, approved: true, notes: "Looks good")

# 4. Poll until complete
orchestrator_status(run_id) → { status: "complete", finalReport: "..." }
```

## orchestrator.yaml (minimal)

```yaml
version: 1

orchestrator:
  name: "My Orchestrator"
  provider: deepseek
  vault:                          # optional — enables RAG knowledge retrieval
    path: /path/to/vault
    embedder: simple              # simple | ollama

providers:
  deepseek:
    api_key: ${DEEPSEEK_API_KEY}
    base_url: https://api.deepseek.com/v1
    model: deepseek-chat

agents:
  - id: hr-agent
    name: HR Specialist
    description: Manages employee onboarding, HR policies, and documentation
    capabilities: [onboarding, rrhh, documentation]
    provider: deepseek
    domain: rrhh                  # enterprise reflection domain
    gate: true                    # pause for human approval after this agent
    gate_criteria:
      - "Employee data is complete and correct"
      - "Documentation checklist is appropriate"
```

## Data directory

Default: `.orchestrator/` adjacent to `orchestrator.yaml`.
Override: `ORCHESTRATOR_DATA_DIR` env var or `data_dir` key in YAML.

## See also

Full documentation: `docs/` directory or [GitHub](https://github.com/BackendKit-labs/backendkit-agents/tree/master/packages/orchestrator-agent)
