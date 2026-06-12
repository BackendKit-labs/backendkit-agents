# @backendkit-labs/curator-agent

Autonomous knowledge ingestion agent for enterprise vaults.

Reads raw documents (policies, meeting minutes, regulations, technical specs) and uses a **reasoning LLM** to extract structured, semantically rich notes — ready for RAG search by enterprise agents.

## How it works

```
document (text / file)
        ↓
  reasoning LLM         ← DeepSeek R1 · Claude Opus · o3-mini · Ollama
  (structured extraction)
        ↓
  validated notes       ← type, area, resumen, tags, frontmatter
        ↓
  vault/rrhh/           ← indexed by enterprise agents via ObsidianRAGProvider
  vault/legal/
  vault/finanzas/ …
```

The curator never copies raw text. It restructures documents into notes with:
- **`resumen`** — 1-2 sentences dense with searchable terms (drives semantic search quality)
- **`type`** — `politica · decision · procedimiento · leccion · norma_externa`
- **`area`** — `rrhh · finanzas · operaciones · ventas · soporte · legal · calidad · general`

---

## Installation

```bash
npm install @backendkit-labs/curator-agent
```

Or use directly with `npx` — no install required.

---

## Configuration

| Env var | Required | Default | Description |
|---|---|---|---|
| `CURATOR_API_KEY` | yes | — | API key for the chosen provider |
| `CURATOR_VAULT_PATH` | yes | — | Absolute path to the vault root |
| `CURATOR_PROVIDER` | no | `deepseek` | `deepseek` · `openai` · `ollama` · `anthropic` |
| `CURATOR_MODEL` | no | `deepseek-reasoner` | Model ID (see provider table below) |
| `CURATOR_BASE_URL` | no | provider default | Override endpoint URL |
| `CURATOR_HTTP_PORT` | no | off | Start HTTP webhook server on this port |
| `CURATOR_POLL_MS` | no | `30000` | Vault polling interval (ms) |

### Provider defaults

| Provider | Default model | Notes |
|---|---|---|
| `deepseek` | `deepseek-reasoner` | DeepSeek R1 — recommended for complex documents |
| `openai` | `o3-mini` | Reasoning model |
| `ollama` | `qwen2.5-coder:7b` | Local, base URL: `http://localhost:11434/v1` |
| `anthropic` | `claude-opus-4-8` | Highest quality; requires Anthropic API key |

---

## Usage

### 1 — MCP server (Claude Code / enterprise agents)

Add to `claude_desktop_config.json` or your MCP client config:

```json
{
  "mcpServers": {
    "curator": {
      "command": "npx",
      "args": ["-y", "@backendkit-labs/curator-agent"],
      "env": {
        "CURATOR_PROVIDER": "deepseek",
        "CURATOR_API_KEY": "sk-...",
        "CURATOR_MODEL": "deepseek-reasoner",
        "CURATOR_VAULT_PATH": "/path/to/vault"
      }
    }
  }
}
```

Then from any agent:

```
curator_ingest_text({
  text: "<full policy text>",
  source: "politica-vacaciones-2026.pdf"
})
```

Use a stronger model for high-stakes documents:

```
curator_ingest_text({
  text: "<gdpr regulation>",
  source: "reglamento-gdpr.pdf",
  provider: "anthropic",
  model: "claude-opus-4-8",
  area_hint: "legal"
})
```

### 2 — Autonomous watcher

Watches `vault/incoming/` for new files and curates them automatically:

```bash
CURATOR_PROVIDER=deepseek \
CURATOR_API_KEY=sk-... \
CURATOR_VAULT_PATH=/path/to/vault \
npx @backendkit-labs/curator-agent curator-watcher
```

Drop any `.txt`, `.md`, or plain-text file into `vault/incoming/` — the watcher picks it up within seconds, curates it, and moves it to `vault/processed/` (or `vault/failed/` on error).

### 3 — HTTP webhook (n8n / automation)

Set `CURATOR_HTTP_PORT=3099` to also start an HTTP server:

```bash
# Ingest raw text
curl -X POST http://localhost:3099/ingest \
  -H "Content-Type: application/json" \
  -d '{"text": "...", "source": "email-from-ceo.txt"}'

# Ingest a file already on disk
curl -X POST http://localhost:3099/ingest \
  -d '{"file_path": "/path/to/document.md"}'
```

### 4 — Programmatic (TypeScript)

```typescript
import { KnowledgeCurator, createProvider } from '@backendkit-labs/curator-agent';

// DeepSeek R1 — reasoning model for complex documents
const curator = new KnowledgeCurator({
  provider: createProvider({
    provider: 'deepseek',
    apiKey: process.env.DEEPSEEK_KEY!,
    model: 'deepseek-reasoner',
  }),
  vaultPath: '/path/to/vault',
});

const result = await curator.curateText(documentText, 'board-meeting-minutes.md');
console.log(`Written: ${result.notesWritten.length} notes in ${result.durationMs}ms`);

// Claude Opus for legal/regulatory documents
const legalCurator = new KnowledgeCurator({
  provider: createProvider({
    provider: 'anthropic',
    apiKey: process.env.ANTHROPIC_KEY!,
    model: 'claude-opus-4-8',
  }),
  vaultPath: '/path/to/vault',
});

await legalCurator.curateFile('/docs/gdpr-compliance.pdf', 'legal');
```

---

## MCP tools reference

### `curator_ingest_text`

Curate raw document text.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `text` | string | yes | Document text (min 50 chars) |
| `source` | string | yes | Origin for audit trail (filename, URL, etc.) |
| `area_hint` | string | no | Primary area hint for the classifier |
| `provider` | string | no | Override provider for this call |
| `model` | string | no | Override model for this call |
| `base_url` | string | no | Override base URL for this call |
| `vault_path` | string | no | Override vault path for this call |

### `curator_ingest_file`

Read a file from disk and curate it. Moves file to `processed/` or `failed/` after processing.

| Parameter | Type | Required | Description |
|---|---|---|---|
| `file_path` | string | yes | Absolute path to the file |
| `area_hint` | string | no | Primary area hint |
| `provider` | string | no | Override provider |
| `model` | string | no | Override model |
| `base_url` | string | no | Override base URL |
| `vault_path` | string | no | Override vault path |

### `curator_list_incoming`

List files pending in `vault/incoming/`.

### `curator_process_incoming`

Process all files in `vault/incoming/` in batch. Accepts the same provider/model overrides.

---

## Document taxonomy

### Types (`tipo`)

| Type | When to use |
|---|---|
| `politica` | Company rules enforced by management. Requires `vigente_desde`. |
| `decision` | A specific decision made, with rationale. Requires `decidido_por`. |
| `procedimiento` | Step-by-step process or runbook. |
| `leccion` | Lesson learned or post-mortem finding. |
| `norma_externa` | External regulation, law, or ISO standard. |

### Areas (`area`)

`rrhh` · `finanzas` · `operaciones` · `ventas` · `soporte` · `legal` · `calidad` · `general`

---

## Output format

Each extracted note is written as a Markdown file with YAML frontmatter:

```markdown
---
title: "Política de Vacaciones — 20 días hábiles anuales"
area: rrhh
tipo: politica
resumen: "Los empleados con más de 1 año de antigüedad acumulan 20 días hábiles de vacaciones anuales; solicitud mínima 15 días antes; requiere aprobación del manager directo."
author: "agent/curator"
date: 2026-06-11
source_ref: "politica-vacaciones-v3.pdf"
tags: ["área/rrhh", "tipo/politica", "estado/vigente"]
vigente_desde: 2026-01-01
version: 3
aplica_a: ["todos los empleados"]
---

## Acumulación

Los empleados con más de 1 año de antigüedad acumulan **20 días hábiles** anuales...
```

---

## Why a reasoning model?

Knowledge extraction is cognitively demanding:
- Understanding implicit rules across 10+ pages
- Correctly classifying ambiguous document types
- Writing `resumen` fields dense with searchable terms
- Detecting relationships between sections

Basic chat models miss nuance and produce shallow `resumen` fields that hurt RAG search recall. **DeepSeek R1 or Claude Opus** are recommended for production vaults.

For internal memos or simple notes where speed matters more than depth, `deepseek-chat` or a local Ollama model works fine.

---

## License

MIT
