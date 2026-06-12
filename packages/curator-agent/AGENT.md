# curator-agent

Knowledge Curator — intelligent document ingestion into enterprise vaults using powerful LLMs.

The curator sits at the entry point of the knowledge pipeline: it takes raw documents (policies,
meeting minutes, regulations, technical docs) and converts them into structured Markdown notes with
rich frontmatter, then writes them to the correct folder of a shared Obsidian-compatible vault.

Enterprise agents (HR, Finance, Ops...) then retrieve this knowledge at query time using their
domain RAG search tools.

## Why a dedicated curator?

Local 3B-7B models reason well from structured context but struggle to extract from dense documents.
A powerful LLM (DeepSeek, Claude, GPT-4) as curator produces clean, well-tagged notes that small
models can use effectively — separating ingestion quality from operational cost.

## Document types supported

| Type | Description | Key fields |
|---|---|---|
| `politica` | Company policy or rule | `vigente_desde`, `version`, `expires_at` |
| `decision` | A decision taken, with rationale | `decidido_por` |
| `procedimiento` | Step-by-step process / runbook | `aplica_a`, `sla` |
| `leccion` | Lesson learned, post-mortem | `severidad`, `fecha_incidente` |
| `norma_externa` | External regulation, ISO, BOE | `fuente_oficial`, `vigente_desde` |

## Output structure

Each curated note is written to `vault/<area>/YYYY-MM-DD-<slug>.md` with:

```yaml
---
title: "Política de Teletrabajo 2026"
area: rrhh
tipo: politica
resumen: "Permite 2 días de teletrabajo semanales, requiere solicitud 48h. Ayuda 50€/mes."
author: "agent/curator"
date: 2026-06-11
source_ref: "politica-teletrabajo-v2.pdf"
tags: ["área/rrhh", "tipo/politica", "estado/vigente"]
vigente_desde: 2026-01-01
version: 2
---

## Reglas principales
...
```

The `resumen` field is optimised for semantic search — the curator is prompted to pack it
with key terms, numbers, dates, and named entities.

## Vault folder layout expected

```
vault/
  incoming/     ← drop files here for automatic processing
  processed/    ← successfully curated files are moved here
  failed/       ← files the LLM could not process
  rrhh/         ← HR notes written by curator
  finanzas/     ← Finance notes
  operaciones/  ← Ops notes
  ventas/       ← Sales notes
  soporte/      ← Support notes
  legal/        ← Legal/regulatory notes
  calidad/      ← Quality/ISO notes
  general/      ← Cross-domain notes
```

## Setup

### Required env vars

| Variable | Description |
|---|---|
| `CURATOR_API_KEY` | DeepSeek / OpenAI-compatible API key |
| `CURATOR_VAULT_PATH` | Absolute path to the shared vault |

### Optional env vars

| Variable | Default | Description |
|---|---|---|
| `CURATOR_MODEL` | `deepseek-chat` | LLM model to use |
| `CURATOR_BASE_URL` | DeepSeek API | Override for Ollama (`http://localhost:11434/v1`) |
| `CURATOR_HTTP_PORT` | _(disabled)_ | Enable HTTP webhook on this port |
| `CURATOR_POLL_MS` | `30000` | Polling interval for incoming/ folder |

## Usage

### 1. MCP tool (another agent calls the curator)

Register in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "curator": {
      "command": "npx",
      "args": ["-y", "@backendkit-labs/curator-agent"],
      "env": {
        "CURATOR_API_KEY": "sk-...",
        "CURATOR_VAULT_PATH": "/path/to/vault"
      }
    }
  }
}
```

Available tools:

- **`curator_ingest_text`** — pass document text directly
- **`curator_ingest_file`** — pass a file path on disk
- **`curator_list_incoming`** — list files pending in vault/incoming/
- **`curator_process_incoming`** — process all files in vault/incoming/

### 2. Autonomous watcher (drop-folder + HTTP webhook)

```bash
CURATOR_API_KEY=sk-... \
CURATOR_VAULT_PATH=/path/to/vault \
CURATOR_HTTP_PORT=3099 \
npx @backendkit-labs/curator-agent/watcher
```

Drop any `.txt`, `.md`, or plain-text file into `vault/incoming/` and it will be
processed automatically within 30 seconds (or immediately via `fs.watch`).

### 3. n8n webhook integration

With `CURATOR_HTTP_PORT=3099` active, configure an n8n HTTP node:

```
POST http://localhost:3099/ingest
Content-Type: application/json

{
  "text": "...extracted document text...",
  "source": "contrato-proveedor-acme.pdf"
}
```

n8n handles: Gmail attachments → extract text → POST to curator → vault updated.

## Deduplication

Before writing, the curator checks if a note with the same date + title slug already exists.
If it does, the note is **skipped** (logged as `notesSkipped`). To force re-ingestion of an
updated document, delete the existing note first or rename the source file.
