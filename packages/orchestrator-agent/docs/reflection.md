# Enterprise Reflection

The enterprise reflection system implements a MAPE-K (Monitor → Analyze → Plan → Execute) loop that watches gate outcomes and, over time, converts recurring failure patterns into deterministic policy rules.

**Requires:** `@backendkit-labs/agent-enterprise >= 0.4.0` and a vault configured in `orchestrator.yaml`.

## Why this matters

Without reflection, human reviewers must remember to apply the same criteria every time a gate fires. If a legal review fails 5 times because contracts are missing a specific clause, someone has to manually remember to check for that clause on the 6th run.

With reflection:
1. System detects the pattern (5 failures with the same failure type in the same domain)
2. Surfaces it as a pending promotion
3. Human approves → pattern becomes a deterministic policy rule
4. From that point, every matching step gets gated automatically with the right criteria — no LLM, no memory required

## The two cables

### Cable 1 — Incident recording

When a gate fires and is approved or rejected, the outcome is recorded for every policy rule that contributed to the gate:
- **Approved** → `success` for those rule IDs
- **Rejected** → `failure` for those rule IDs

This builds the statistical base for promotion and demotion decisions.

### Cable 2 — Rule enforcement

Before any step runs, the active policy rules in `manifest.yaml` are checked against the step:
- Domain match + keyword match → gate is forced, criteria injected
- This happens **regardless** of whether `gate: true` is set in the agent config
- **No LLM involved** — this is a synchronous rule check, not a prediction

Rules also feed the dynamic planner (Milestone 3): when generating a plan, active rules are injected into the planner prompt so the LLM sets `gate: true` and copies the criteria into the plan from the start.

## MAPE-K cycle

```
Monitor   ← Gate outcomes (approved/rejected) + failure types recorded per domain
    ↓
Analyze   ← Pattern detection: domain + failureType pairs that exceed threshold
    ↓
Plan      ← Pending promotions: "This pattern occurred N times — promote to rule?"
    ↓
Execute   ← Human approves/rejects via orchestrator_reflect_promote
            Approved → deterministic rule in manifest.yaml (Cable 2)
            Rejected → audit note, pattern discarded
```

## Viewing the reflection dashboard

```
orchestrator_reflect
  config_path: /company/orchestrator.yaml
```

Returns three sections:

### Pending Promotions
Patterns that crossed the severity threshold (e.g., 3 failures of the same type in the same domain). Each has a `promotion_id` in format `"domain::failureType"`.

### Active Policy Rules
Currently enforced rules. Each shows outcome statistics — how many times it fired and whether approvals or rejections followed.

### Demotion Candidates
Rules with ≥50% failure rate over ≥4 applications. These rules are triggering gates that humans consistently reject, which means the rule is too broad or poorly calibrated.

## Promoting a pattern to a policy rule

```
orchestrator_reflect_promote
  config_path: /company/orchestrator.yaml
  promotion_id: "rrhh::data-validation-failure"
  approved: true
  approver: "ana@company.com"
  reason: "Confirmed — 5 incidents in 2 weeks, all onboarding tasks with incomplete employee data"
```

On approval:
- A new entry is written to `manifest.yaml` (in the vault)
- The rule is active immediately — no restart required
- All future steps matching `domain: rrhh` with keywords matching the pattern will be automatically gated

To reject (discard the pattern):
```
orchestrator_reflect_promote
  promotion_id: "rrhh::data-validation-failure"
  approved: false
  approver: "ana@company.com"
  reason: "One-off incident — not a systemic issue"
```

The pattern is discarded and an audit note is written to the failure catalog.

## Demoting a policy rule

If a rule has a high failure rate (gates fire but humans reject them), it's too aggressive.

```
orchestrator_reflect_demote
  config_path: /company/orchestrator.yaml
  rule_id: "rule-002"
  approver: "ana@company.com"
  reason: "Rule fires on all contracts, not just sensitive ones — too broad"
```

On demotion:
- Rule is removed from `manifest.yaml`
- Audit entry is written to the failure catalog
- The rule can be re-promoted in the future if the pattern recurs

## manifest.yaml

Policy rules are stored in `manifest.yaml` inside the vault. This file is auto-managed by the reflection system — do not edit it manually.

```yaml
# manifest.yaml (auto-managed)
policyRules:
  - id: rule-001
    name: "HR data must be validated before onboarding"
    trigger:
      domain: rrhh
      pattern: data-validation
      minOccurrences: 3
    if:
      domain: rrhh
      keywords: [onboarding, datos, empleado, incorporación]
    then:
      mustInclude:
        - "checklist de documentación completo"
        - "datos del empleado verificados"
```

## Workflow summary

```
Week 1-2: Runs accumulate gate outcomes
          → 5 rejections in rrhh::data-validation-failure

orchestrator_reflect → shows pending promotion

orchestrator_reflect_promote(approved: true)
  → rule-001 created in manifest.yaml

Week 3+: All hr-agent steps auto-gated with rule-001 criteria
         No human needs to remember — Cable 2 enforces it

3 months later: rule-001 has 80% rejection rate
orchestrator_reflect → shows demotion candidate

orchestrator_reflect_demote(rule_id: rule-001)
  → rule removed, audit logged
  → back to manual review until pattern recurs
```

## Recommended cadence

| Frequency | Action |
|-----------|--------|
| Weekly | `orchestrator_reflect` — review pending promotions, approve or reject |
| Monthly | `orchestrator_reflect` — check demotion candidates |
| Quarterly | Review active rules for accuracy and relevance |
