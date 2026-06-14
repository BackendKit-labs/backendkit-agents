# @backendkit-labs/orchestrator-agent

Config-driven multi-agent orchestration for enterprise workflows. Decomposes natural language tasks into sub-tasks, coordinates specialist agents via a shared knowledge vault, and enforces human approval gates — with full audit trail.

## What it does

- **Plans**: decomposes a task into a dependency-ordered plan (static flow or LLM-generated)
- **Executes**: runs steps in parallel when dependencies allow, each delegated to a specialist agent
- **Gates**: pauses for human approval at critical steps, either by config or by active policy rules
- **Persists**: every run is saved to disk (or Redis) — survives restarts, resumes after gate approval
- **Learns**: enterprise reflection monitors gate outcomes and promotes recurring failure patterns into deterministic policy rules

## Installation

```bash
npm install -g @backendkit-labs/orchestrator-agent
# or as a local dep in a monorepo
npm install @backendkit-labs/orchestrator-agent
```

## Quick start (5 minutes)

**1. Create `orchestrator.yaml`**

```yaml
version: 1

orchestrator:
  name: "My Orchestrator"
  provider: deepseek

providers:
  deepseek:
    api_key: ${DEEPSEEK_API_KEY}
    base_url: https://api.deepseek.com/v1
    model: deepseek-chat

agents:
  - id: analyst
    name: Data Analyst
    description: Analyzes data and produces reports
    capabilities: [analysis, reporting, metrics]
    provider: deepseek

  - id: writer
    name: Technical Writer
    description: Writes documents and summaries
    capabilities: [writing, documentation, summaries]
    provider: deepseek
```

**2. Create `.env`**

```
DEEPSEEK_API_KEY=sk-...
```

**3. Wire into Claude Desktop** (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "orchestrator": {
      "command": "npx",
      "args": ["-y", "@backendkit-labs/orchestrator-agent"],
      "env": {
        "DEEPSEEK_API_KEY": "sk-..."
      }
    }
  }
}
```

**4. Run a task** (in Claude Desktop):

```
orchestrator_run
  config_path: /path/to/orchestrator.yaml
  task: "Analyze Q1 sales data and write an executive summary"
```

## Feature overview

| Feature | Description |
|---------|-------------|
| **Dynamic planning** | LLM decomposes any task into a dependency-ordered plan |
| **Static flows** | Pre-defined YAML workflows triggered by regex or `flow_id` |
| **Parallel execution** | Independent steps run concurrently (`Promise.all`) |
| **Human gates** | Steps pause for approval — configurable per-agent or per-step |
| **Policy rules (Cable 2)** | Active rules automatically gate matching steps — no LLM involved |
| **LanceDB RAG** | Incremental vault indexing with ANN search, fast at scale |
| **Redis + BullMQ** | Distributed execution across worker processes for production |
| **HTTP trigger** | REST endpoint for n8n / external system integration |
| **Enterprise reflection** | MAPE-K: monitors outcomes → promotes patterns → enforces rules |
| **Vault writer** | Final reports auto-saved to the knowledge vault |

## MCP Tools

| Tool | Description |
|------|-------------|
| `orchestrator_run` | Start a task — returns `runId` immediately |
| `orchestrator_status` | Poll status by `runId` |
| `orchestrator_approve` | Approve or reject a waiting gate |
| `orchestrator_list_runs` | List all persisted runs |
| `orchestrator_list_agents` | Show configured agents |
| `orchestrator_reflect` | View pending promotions, active rules, demotion candidates |
| `orchestrator_reflect_promote` | Approve or reject a pattern promotion to policy rule |
| `orchestrator_reflect_demote` | Demote a policy rule with audit trail |

## Documentation

- [Configuration reference](docs/config-reference.md) — full `orchestrator.yaml` schema
- [MCP tools](docs/mcp-tools.md) — parameters, examples, and responses for all 8 tools
- [Static flows](docs/static-flows.md) — YAML flow format, payload interpolation, auto-detection
- [Gates and policies](docs/gates-and-policies.md) — human approval, Cable 2 automatic gates
- [HTTP trigger](docs/http-trigger.md) — REST API for n8n and external systems
- [Redis + workers](docs/redis-workers.md) — distributed execution with BullMQ
- [RAG vault](docs/rag-vault.md) — LanceDB incremental indexing, embedder options
- [Enterprise reflection](docs/reflection.md) — MAPE-K loop, promotions, demotions

## Data directory

By default, run state and RAG index live in `.orchestrator/` adjacent to your `orchestrator.yaml`:

```
.orchestrator/
  runs/           ← JSON run files (one per run)
  rag-lance/      ← LanceDB vector index
```

Override with `ORCHESTRATOR_DATA_DIR` env var or `data_dir` in the YAML.

## License

MIT
