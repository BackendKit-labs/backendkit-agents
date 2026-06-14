# Static Flows

Static flows are pre-defined YAML workflows for repeatable processes. When a task matches a flow's `trigger` regex (or a `flow_id` is passed explicitly), the flow is used instead of LLM planning. This gives you deterministic, auditable execution paths for critical processes.

## When to use static flows

| Use static flows | Use dynamic planning |
|-----------------|---------------------|
| Regulated processes (onboarding, contracts) | Open-ended research |
| Steps must always happen in a fixed order | Task structure unknown in advance |
| Payload data is well-structured | Exploratory or creative tasks |
| Compliance requires auditability | One-off or ad-hoc tasks |

## Declaring flows in `orchestrator.yaml`

```yaml
flows:
  - id: onboarding-empleado
    file: ./flows/onboarding-empleado.yaml
    trigger: "onboarding|nuevo empleado|alta de personal|incorporación"

  - id: presupuesto-anual
    file: ./flows/presupuesto.yaml
    # No trigger: only activated via explicit flow_id parameter
```

- `id` — unique identifier, used in `orchestrator_run flow_id`
- `file` — path to the flow YAML, relative to `orchestrator.yaml`
- `trigger` — regex matched against the task text (case-insensitive). First match wins.

## Flow YAML format

```yaml
version: 1
id: flow-id                               # must match the id in orchestrator.yaml
name: "Flow name — {{payload.nombre}}"    # supports payload interpolation
description: "What this flow does"

steps:
  - id: step-1                    # unique within the flow
    agent: agent-id               # must match an agent id in orchestrator.yaml
    task: >                       # task description — sent to the agent's LLM
      Do something for {{payload.nombre}}.
      Include details about {{payload.puesto}}.
    depends_on: []                # list of step ids that must complete first
    gate: true                    # optional: pause for human approval
    gate_criteria:                # optional: checklist shown to the approver
      - "Criterion 1"
      - "Criterion 2"

  - id: step-2
    agent: other-agent-id
    task: >
      Process results for {{payload.nombre}}.
    depends_on: [step-1]          # waits for step-1 to complete (and gate approved)
```

## Payload interpolation

Any `{{payload.key}}` in `name`, `description`, or `task` fields is replaced with the value from the `payload` object passed to `orchestrator_run`.

**Example call:**

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

**In the flow YAML**, `{{payload.nombre}}` becomes `María García`, etc.

Missing keys expand to `""` — so include a validation step or make payloads well-defined.

## Parallel execution

Steps with non-overlapping `depends_on` chains run in parallel. The executor collects all steps whose dependencies are satisfied and runs them concurrently with `Promise.all`.

```yaml
steps:
  - id: s1       # runs first (no deps)
    depends_on: []

  - id: s2       # runs in parallel with s3 (both wait for s1)
    depends_on: [s1]

  - id: s3       # runs in parallel with s2 (both wait for s1)
    depends_on: [s1]

  - id: s4       # waits for both s2 and s3 to complete
    depends_on: [s2, s3]
```

Execution timeline:
```
t0: s1 ──────────────────┐
t1:                       ├── s2 ────┐
t1:                       └── s3 ────┤
t2:                                   └── s4
```

## Complete example

The file `flows/onboarding-empleado.yaml` shows a real 4-step flow:

```
s1-hr-checklist          [hr-agent, GATE]
  ↓
s2-it-accesos ──────┐    [it-agent, parallel]
s3-legal-contrato ──┘    [legal-agent, GATE, parallel]
  ↓
s4-bienvenida            [writer-agent]
```

- Steps 2 and 3 run in parallel after s1's gate is approved
- Step 3 has its own gate (legal review)
- Step 4 waits for both 2 and 3 to complete before generating the welcome letter

## Auto-detection vs explicit `flow_id`

**Auto-detection** — task text is matched against each flow's `trigger` regex:

```
orchestrator_run
  task: "dar de alta al nuevo empleado Juan Pérez"
  # "nuevo empleado" matches trigger "onboarding|nuevo empleado|alta de personal"
  # → onboarding-empleado flow is selected automatically
```

**Explicit** — pass `flow_id` to skip auto-detection:

```
orchestrator_run
  flow_id: onboarding-empleado
  task: "anything — task text is used for context but flow is forced"
  payload: { nombre: "Juan", ... }
```

## Tips

- Keep flow step IDs stable — they appear in `orchestrator_status` and run history
- Use `>` (YAML block scalar) for task text to keep it readable
- Gates in flows behave exactly like gates in dynamic plans — `orchestrator_approve` resumes from the next pending step
- `depends_on: []` is required even for the first step (not optional)
