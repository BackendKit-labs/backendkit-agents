# MCP Tools Reference

All tools require `config_path` — the absolute path to `orchestrator.yaml`. This is how the orchestrator knows which agents, providers, and flows to use.

---

## `orchestrator_run`

Starts a coordinated multi-agent task. Planning is synchronous; execution runs in the background. Returns `runId` immediately.

**Plan selection order:**
1. If `flow_id` is provided → uses that static flow
2. If `flows:` are declared in YAML and the task matches a `trigger` regex → uses that flow
3. Otherwise → LLM generates a dynamic plan

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `config_path` | string | yes | Absolute path to `orchestrator.yaml` |
| `task` | string | yes | Task in natural language |
| `flow_id` | string | no | Force a specific static flow ID |
| `payload` | object | no | `{ key: value }` for `{{payload.key}}` interpolation in static flows |

### Example

```
orchestrator_run
  config_path: /company/orchestrator.yaml
  task: "Analyze last quarter's sales and write an executive summary"
```

```
orchestrator_run
  config_path: /company/orchestrator.yaml
  flow_id: onboarding-empleado
  payload:
    nombre: "María García"
    puesto: "Senior Developer"
    area: "Engineering"
    fecha_ingreso: "2026-07-01"
    modalidad: "hybrid"
    remuneracion: "$5,000/month"
```

### Response

```
## Run iniciado (plan dinámico)
runId: `run-1751234567890-abc123`
status: running

### Plan: Analyze Q1 sales and produce executive summary
  • [analyst-agent] Retrieve and analyze Q1 sales data across all regions
  • [writer-agent] [GATE] Write executive summary with insights and recommendations

Poll con `orchestrator_status` para ver el progreso.
```

---

## `orchestrator_status`

Returns the current state of a run. Poll this until status is `complete`, `failed`, or `waiting_gate`.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `config_path` | string | yes | |
| `run_id` | string | yes | Returned by `orchestrator_run` |

### Status values

| Status | Meaning |
|--------|---------|
| `running` | Steps are executing |
| `waiting_gate` | Paused — human approval required |
| `complete` | All steps finished successfully |
| `failed` | Execution stopped due to error or rejected gate |

### Response when `waiting_gate`

```
## Run `run-1751234567890-abc123`
status: **waiting_gate**
task: Analyze Q1 sales and write executive summary
started: 2026-07-01T10:00:00.000Z

### Pasos completados (1)
✓ [analyst-agent] Retrieve and analyze Q1 sales data...

### ⏸ Gate waiting for approval
Step: `s2-writer`  Agent: writer-agent
Requested: 2026-07-01T10:02:34.000Z

Criteria to evaluate:
  - Summary covers all key metrics
  - Recommendations are actionable

**Agent output:**
## Q1 Sales Analysis — Executive Summary
[...output from writer-agent...]

Use `orchestrator_approve` with run_id: "run-1751234567890-abc123" to continue or reject.
```

### Response when `complete`

```
## Run `run-1751234567890-abc123`
status: **complete**
...
📝 Guardado en vault: `run-1751234567890-abc123 — Analyze Q1 sales.md`

### Reporte final
[consolidated report from all agents]
```

---

## `orchestrator_approve`

Approves or rejects a gate. On approval, execution resumes automatically from the next step. On rejection, the run is marked `failed` with the provided notes.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `config_path` | string | yes | |
| `run_id` | string | yes | |
| `approved` | boolean | yes | `true` to resume, `false` to stop |
| `notes` | string | no | Required when rejecting; optional context when approving |

### Example — approve

```
orchestrator_approve
  config_path: /company/orchestrator.yaml
  run_id: run-1751234567890-abc123
  approved: true
  notes: "Analysis is accurate, summary approved for distribution"
```

### Example — reject

```
orchestrator_approve
  config_path: /company/orchestrator.yaml
  run_id: run-1751234567890-abc123
  approved: false
  notes: "Summary missing regional breakdown — needs revision"
```

---

## `orchestrator_list_runs`

Lists persisted runs with status summary. Most recent runs first. Runs survive server restarts.

### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `config_path` | string | required | |
| `status` | enum | `all` | Filter: `running` \| `waiting_gate` \| `complete` \| `failed` \| `all` |
| `limit` | number | 20 | Max runs to return (1–100) |

### Example

```
orchestrator_list_runs
  config_path: /company/orchestrator.yaml
  status: waiting_gate
```

### Response

```
## Runs (2 · status=waiting_gate)

⏸ `run-1751234567890-abc123`  **waiting_gate**  2026-07-01 10:00
   Analyze Q1 sales and write executive summary
   ⏸ gate: step `s2-writer` — use `orchestrator_approve`

⏸ `run-1751234567880-xyz456`  **waiting_gate**  2026-06-30 14:23
   Onboarding de María García — Senior Developer
   ⏸ gate: step `s1-hr-checklist` — use `orchestrator_approve`
```

---

## `orchestrator_list_agents`

Lists all agents configured in `orchestrator.yaml`.

### Parameters

| Parameter | Type | Required |
|-----------|------|----------|
| `config_path` | string | yes |

---

## `orchestrator_reflect`

Shows the enterprise reflection dashboard: pending pattern promotions, active policy rules, and demotion candidates.

**When to use:** Periodically (e.g., weekly) to review what patterns the system has detected and decide whether to promote them to policy rules.

### Parameters

| Parameter | Type | Required |
|-----------|------|----------|
| `config_path` | string | yes |

### Response structure

```
## Reflection Status — bk-enterprise

### Pending Promotions (1)
These patterns crossed the severity threshold. Approve to create a policy rule.

**1. rrhh::data-validation-failure**
   domain: rrhh | failureType: data-validation-failure | occurrences: 5
   detected: 2026-06-28T09:00:00.000Z
   → `orchestrator_reflect_promote`  promotion_id: "rrhh::data-validation-failure"

### Active Policy Rules (2)
Enforced automatically before any matching step (Cable 2).

**[rule-001] HR data must be validated**
   trigger: domain rrhh | pattern: data-validation
   outcomes: 12 success / 1 failure

### Demotion Candidates (1)
Rules with ≥50% failure rate over ≥4 applications.

**[rule-002] Mandatory legal review for all contracts**
   outcomes: 1 success / 5 failure (83% failure rate)
   → `orchestrator_reflect_demote`  rule_id: "rule-002"
```

---

## `orchestrator_reflect_promote`

Approves or rejects a pending pattern promotion. Approving creates a deterministic policy rule in `manifest.yaml` — enforced by Cable 2 on every matching step from that point forward.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `config_path` | string | yes | |
| `promotion_id` | string | yes | Format `"domain::failureType"` — copy from `orchestrator_reflect` |
| `approved` | boolean | yes | |
| `approver` | string | yes | Name or email — written to audit trail |
| `reason` | string | no | Required when rejecting |

### Example — approve

```
orchestrator_reflect_promote
  config_path: /company/orchestrator.yaml
  promotion_id: "rrhh::data-validation-failure"
  approved: true
  approver: "ana@company.com"
  reason: "Pattern confirmed — 5 incidents in 2 weeks, all in onboarding"
```

### Response

```
### Promotion approved ✓
Rule created: **[rule-001] HR data must be validated**
domain: rrhh | failureType: data-validation-failure
approver: ana@company.com

Rule is now active — matching steps will be automatically gated (Cable 2).
```

---

## `orchestrator_reflect_demote`

Demotes an active policy rule with a high failure rate. Removes it from `manifest.yaml` with a full audit entry.

### Parameters

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `config_path` | string | yes | |
| `rule_id` | string | yes | Copy from `orchestrator_reflect` demotion candidates |
| `approver` | string | yes | Name or email |
| `reason` | string | yes | Reason for demotion |

### Example

```
orchestrator_reflect_demote
  config_path: /company/orchestrator.yaml
  rule_id: "rule-002"
  approver: "ana@company.com"
  reason: "Too broad — triggers on all contracts, not just sensitive ones"
```

---

## Common patterns

### Fire and forget (no gates)

```
orchestrator_run → runId
# wait 30s or poll
orchestrator_status → complete
```

### With human gates

```
orchestrator_run → runId
# poll every 10s
orchestrator_status → waiting_gate
# review output, approve
orchestrator_approve(approved: true)
# poll until complete
orchestrator_status → complete
```

### Resume after server restart

```
# Server restarted — waiting_gate runs survive, running runs are marked failed
orchestrator_list_runs(status: waiting_gate)
# Find the run, review, approve
orchestrator_approve(run_id, approved: true)
```
