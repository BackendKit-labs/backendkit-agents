# Configuration Reference — `orchestrator.yaml`

Complete schema reference for `orchestrator.yaml`. All paths are resolved relative to the config file unless they are absolute.

## Top-level structure

```yaml
version: 1                  # required, always 1

orchestrator:               # orchestrator settings
  ...

providers:                  # LLM provider credentials
  ...

agents:                     # specialist agent definitions
  ...

flows:                      # optional: pre-defined static workflows
  ...
```

---

## `orchestrator`

```yaml
orchestrator:
  name: "Enterprise Orchestrator"   # display name (default: "Orchestrator")
  provider: deepseek                # which provider the orchestrator LLM uses
  model: deepseek-reasoner          # optional: override the provider's default model
  data_dir: ./data                  # optional: override data directory (default: .orchestrator/)
  vault:                            # optional: knowledge vault for RAG
    path: /path/to/vault            # absolute or relative path to Obsidian vault
    embedder: simple                # "simple" (no deps) | "ollama" (better quality)
    ollama_host: http://localhost:11434   # only used when embedder = ollama
    ollama_model: nomic-embed-text       # only used when embedder = ollama
```

### `data_dir` priority

1. `ORCHESTRATOR_DATA_DIR` environment variable
2. `data_dir` in `orchestrator.yaml` (resolved relative to the config file)
3. Default: `.orchestrator/` adjacent to `orchestrator.yaml`

---

## `providers`

Each key is a provider ID referenced by agents and the orchestrator.

```yaml
providers:
  deepseek:
    api_key: ${DEEPSEEK_API_KEY}          # env var interpolation supported
    base_url: https://api.deepseek.com/v1
    model: deepseek-chat

  local:
    api_key: ollama                        # Ollama ignores the key but needs a value
    base_url: http://localhost:11434/v1
    model: qwen2.5:7b

  anthropic:
    api_key: ${ANTHROPIC_API_KEY}
    base_url: https://api.anthropic.com/v1
    model: claude-sonnet-4-6
```

All fields:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `api_key` | string | no | API key; supports `${ENV_VAR}` interpolation |
| `base_url` | string | no | Override API endpoint (for Ollama, local proxies, etc.) |
| `model` | string | **yes** | Model identifier used for all calls to this provider |

---

## `agents`

Each entry defines a specialist agent. The orchestrator routes sub-tasks to agents by matching capabilities and the generated plan.

```yaml
agents:
  - id: hr-agent                    # unique identifier (used in plans and flows)
    name: "HR Specialist"           # human-readable name
    description: "Manages onboarding, HR policies, and documentation"
    capabilities:                   # keywords used by the planner to select this agent
      - onboarding
      - rrhh
      - documentation
    provider: local                 # which provider to use (must match a key in providers:)
    system_prompt: |                # optional: override the default specialist prompt
      You are an HR specialist...
    domain: rrhh                    # optional: enterprise reflection domain
    gate: true                      # optional: pause for human approval after this agent
    gate_criteria:                  # optional: checklist shown to the approver
      - "Employee data is complete and correct"
      - "Documentation checklist is appropriate for the role"
    transport:                      # optional: connect to an external MCP specialist server
      type: http
      url: http://specialist-server:3001
```

### Agent fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `id` | string | required | Unique ID; used in plans, flows, and `depends_on` |
| `name` | string | required | Display name |
| `description` | string | required | Used by the planner to understand the agent's role |
| `capabilities` | string[] | required | Keywords; planner uses these to route tasks |
| `provider` | string | `"default"` | Provider ID from `providers:` section |
| `system_prompt` | string | auto-generated | Override the specialist's system prompt |
| `domain` | string | none | Enterprise reflection domain (e.g. `rrhh`, `legal`, `finanzas`) |
| `gate` | boolean | `false` | Always pause for human approval after this agent |
| `gate_criteria` | string[] | `[]` | Approval checklist shown to the human reviewer |
| `transport` | object | none | Connect to an external MCP server instead of calling the LLM directly |

### Transport options

```yaml
transport:
  type: stdio           # spawn a local process
  command: node
  args: [./specialist-server.js]
  env:
    API_KEY: ${SPECIALIST_API_KEY}

# or

transport:
  type: http            # connect to a running HTTP MCP server
  url: http://localhost:3001
```

---

## `flows`

Declare pre-defined static flows. When a task matches the `trigger` regex, the flow is used instead of dynamic planning.

```yaml
flows:
  - id: onboarding-empleado
    file: ./flows/onboarding-empleado.yaml    # relative to orchestrator.yaml
    trigger: "onboarding|nuevo empleado|alta de personal"   # optional regex

  - id: presupuesto-anual
    file: ./flows/presupuesto.yaml
    # No trigger: only used when flow_id is passed explicitly to orchestrator_run
```

See [Static Flows](static-flows.md) for the flow YAML format.

---

## Environment variable interpolation

Any string value in `orchestrator.yaml` can reference environment variables:

```yaml
api_key: ${DEEPSEEK_API_KEY}
base_url: ${OLLAMA_HOST:-http://localhost:11434}/v1
```

Variables are expanded at load time. Variables not set in the environment expand to `""`.

---

## Complete example

```yaml
version: 1

orchestrator:
  name: "Enterprise Orchestrator"
  provider: deepseek
  data_dir: ./data
  vault:
    path: /shared/company-vault
    embedder: ollama
    ollama_host: http://localhost:11434
    ollama_model: nomic-embed-text

providers:
  deepseek:
    api_key: ${DEEPSEEK_API_KEY}
    base_url: https://api.deepseek.com/v1
    model: deepseek-chat

  local:
    api_key: ollama
    base_url: http://localhost:11434/v1
    model: qwen2.5:7b

flows:
  - id: onboarding-empleado
    file: ./flows/onboarding-empleado.yaml
    trigger: "onboarding|nuevo empleado|alta de personal|incorporación"

agents:
  - id: hr-agent
    name: "HR Specialist"
    description: "Manages employee onboarding and HR documentation"
    capabilities: [onboarding, rrhh, documentation, checklist]
    provider: local
    domain: rrhh
    gate: true
    gate_criteria:
      - "Employee data is complete and correct"
      - "Documentation checklist is appropriate for the role"

  - id: it-agent
    name: "IT Specialist"
    description: "Provisions accounts, access, and equipment"
    capabilities: [accounts, access, equipment, it-setup]
    provider: local
    domain: operaciones

  - id: legal-agent
    name: "Legal Specialist"
    description: "Reviews contracts and regulatory compliance"
    capabilities: [contracts, legal, compliance, labor-law]
    provider: local
    domain: legal
    gate: true
    gate_criteria:
      - "Contract complies with current labor regulations"
      - "Confidentiality clauses are appropriate for the role"

  - id: writer-agent
    name: "Technical Writer"
    description: "Consolidates results and writes reports and communications"
    capabilities: [writing, reports, communications, summaries]
    provider: deepseek
    domain: operaciones

  - id: analyst-agent
    name: "Data Analyst"
    description: "Analyzes data, metrics, and generates insights"
    capabilities: [data-analysis, metrics, reporting, insights]
    provider: deepseek
    domain: finanzas

  - id: risk-agent
    name: "Risk Specialist"
    description: "Identifies and evaluates technical and operational risks"
    capabilities: [risk-assessment, mitigation, contingency]
    provider: deepseek
    domain: operaciones
```
