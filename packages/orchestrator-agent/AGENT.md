# orchestrator-agent

Config-driven orchestration agent. Decomposes natural language tasks into sub-tasks, routes each to the right specialist via `orchestrator.yaml`, and consolidates results. Supports local LLMs (Ollama) and shared knowledge vaults.

## Tools

- `orchestrator_run` — decompose and execute a task end-to-end
- `orchestrator_list_agents` — list configured specialists
- `orchestrator_status` — get checkpoint status for resume

## orchestrator.yaml

```yaml
version: 1

orchestrator:
  name: "Enterprise Orchestrator"
  provider: deepseek
  vault:
    path: /path/to/shared-vault
    embedder: simple          # simple (no deps) | ollama (requires Ollama)
    ollama_host: http://localhost:11434
    ollama_model: nomic-embed-text

providers:
  deepseek:
    api_key: ${DEEPSEEK_API_KEY}
    base_url: https://api.deepseek.com
    model: deepseek-chat
  local:
    api_key: ollama
    base_url: http://localhost:11434/v1
    model: llama3.2:3b

agents:
  - id: hr
    name: HR Specialist
    description: Recursos humanos, nómina, altas y bajas de empleados
    capabilities: [onboarding, payroll, leave, hr-policies]
    provider: local               # dato sensible → Ollama, nunca sale de la empresa

  - id: finance
    name: Finance Specialist
    description: Presupuestos, facturas y reportes financieros
    capabilities: [budgeting, invoicing, financial-reports, approvals]
    provider: local

  - id: code
    name: Code Specialist
    description: Desarrollo TypeScript, revisión de código, testing
    capabilities: [typescript, code-review, testing, refactoring]
    provider: deepseek
    transport:
      type: http
      url: http://localhost:3001   # optional: connect to specialist MCP server
```

## Provider rules

| Data type | Provider | Reason |
|---|---|---|
| Personal (HR, payroll, legal) | `local` → Ollama | Never leaves the company |
| Reasoning, reports, code | `deepseek` or `anthropic` | Better quality |
| Pilot / no Ollama | `simple` embedder | TF-IDF, no dependencies |

## Adding agents

Add an entry to `agents:` in `orchestrator.yaml`. No code changes needed.
The orchestrator's system prompt is generated from the config at runtime.
