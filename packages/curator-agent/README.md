# @backendkit-labs/curator-agent

**Autonomous knowledge ingestion agent for enterprise vaults.**

Reads raw documents (technical docs, policies, meeting minutes, regulations) and uses a **reasoning LLM** to extract structured, semantically rich notes — optimized for RAG search by enterprise agents.

## ⚡ Quick Start (3 minutes)

### 1. Create `.env` File

```bash
# Copy the example
cp .env.example .env

# Edit with your credentials
# CURATOR_API_KEY=sk-your-key
# CURATOR_VAULT_PATH=/path/to/vault
```

### 2. Prepare Vault Structure

```bash
mkdir vault/incoming vault/processed vault/failed
```

Or copy files to `vault/incoming/`:
```bash
cp ../bk-agent/documentation/*.md vault/incoming/
```

### 3. Run Curator-Agent

**Option A: Using npm script (recommended)**
```bash
# Loads .env automatically via dotenv
npm run watch-vault
```

**Option B: Direct command**
```bash
npx @backendkit-labs/curator-agent curator-watcher
# Variables loaded from .env via node -r dotenv/config
```

**Option C: Process single file**
```bash
node -r dotenv/config ./dist/watcher.js --file "vault/incoming/my-doc.md"
```

### 4. Check Results

Processed files move to:
- ✅ `vault/processed/` — Successfully curated
- ❌ `vault/failed/` — Failed (check error logs)

Curated semantic notes appear in your vault, indexed and ready for agent search.

---

## How It Works

```
document (text / file)
        ↓
  reasoning LLM         ← DeepSeek R1 · Claude Opus · o3-mini · Ollama
  (structured extraction)
        ↓
  validated notes       ← type, area, resumen, tags, frontmatter
        ↓
  vault/backend/        ← indexed by enterprise agents via ObsidianRAGProvider
  vault/commands/
  vault/architecture/ …
```

The curator restructures raw documents into semantically rich notes with:
- **`resumen`** — 1-2 searchable sentences (optimized for semantic search)
- **`tipo`** — `guia · referencia · procedimiento · leccion · norma_externa`
- **`area`** — `backend · commands · integration · architecture · workflow`
- **`tags`** — Auto-extracted keywords for indexing
- **`frontmatter`** — YAML metadata for filtering & cross-referencing

---

## Installation

### Option A: Use with `npx` (Recommended — No Install)
```bash
npx @backendkit-labs/curator-agent curator-watcher
```

### Option B: Install Locally
```bash
npm install @backendkit-labs/curator-agent
npm run watch-vault
```

### Option C: Install Globally
```bash
npm install -g @backendkit-labs/curator-agent
curator-agent curator-watcher
```

---

## Configuration with .env File

### 1️⃣ Create `.env` File

In the curator-agent directory, create a `.env` file:

```bash
# Windows PowerShell
New-Item -Path ".env" -ItemType File
# or copy from example
Copy-Item ".env.example" -Destination ".env"
```

### 2️⃣ Fill in Your Credentials

Edit `.env` with your API key and vault path:

```env
CURATOR_API_KEY=sk-your-deepseek-key-here
CURATOR_VAULT_PATH=C:\Users\mairon.cuello\development\workspace-ia\agent-framework-examples\bk-agent-vault
CURATOR_PROVIDER=deepseek
CURATOR_MODEL=deepseek-reasoner
```

### 3️⃣ Run with `.env` Loaded

```bash
# Uses dotenv to load .env automatically
npm run watch-vault

# Or directly with npx
node -r dotenv/config ./dist/watcher.js
```

### Required Environment Variables

```bash
# API key for your chosen LLM provider
CURATOR_API_KEY=sk-...

# Absolute path to vault root
CURATOR_VAULT_PATH=/path/to/vault
```

### Optional Environment Variables

| Env var | Default | Description | Example |
|---|---|---|---|
| `CURATOR_PROVIDER` | `deepseek` | LLM provider | `deepseek` \| `openai` \| `anthropic` \| `ollama` |
| `CURATOR_MODEL` | `deepseek-reasoner` | Model ID | `deepseek-reasoner` \| `o3-mini` \| `claude-opus-4-8` |
| `CURATOR_BASE_URL` | provider default | Override API endpoint | `https://api.deepseek.com/v1` |
| `CURATOR_HTTP_PORT` | off | Start HTTP webhook server | `3099` |
| `CURATOR_POLL_MS` | `30000` | Folder watch interval (ms) | `30000` |

### Provider Options & Defaults

| Provider | Default Model | Speed | Cost | Quality | Best For |
|---|---|---|---|---|---|
| **deepseek** | `deepseek-reasoner` | Slower | Low ✅ | Excellent ✅ | **Technical docs (recommended)** |
| **openai** | `o3-mini` | Medium | Medium | Excellent | Complex reasoning |
| **anthropic** | `claude-opus-4-8` | Slower | High | Best | Regulatory/legal docs |
| **ollama** | `qwen2.5-coder:7b` | Fast | Free ✅ | Good | Private vault, no API calls |

**Recommended for technical documentation:** `deepseek-reasoner` (best semantic extraction at lowest cost)

---

## Usage

### 1️⃣ Autonomous Folder Watcher (Recommended)

**Setup:** Create vault folder structure
```bash
mkdir vault/incoming vault/processed vault/failed
```

**Run watcher:**
```bash
export CURATOR_API_KEY="sk-your-key"
export CURATOR_VAULT_PATH="/path/to/vault"

npx @backendkit-labs/curator-agent curator-watcher
```

**Use:** Drop files into `vault/incoming/` — curator automatically processes them:
- ✅ Successful → `vault/processed/`
- ❌ Failed → `vault/failed/`

Files are curated into semantic notes within seconds.

---

### 2️⃣ Process Single File

```bash
export CURATOR_API_KEY="sk-your-key"
export CURATOR_VAULT_PATH="/path/to/vault"

npx @backendkit-labs/curator-agent curator-ingest-file \
  --file "/path/to/document.md"
```

---

### 3️⃣ MCP Server (Claude Code / Enterprise Agents)

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "curator": {
      "command": "npx",
      "args": ["-y", "@backendkit-labs/curator-agent"],
      "env": {
        "CURATOR_API_KEY": "sk-...",
        "CURATOR_VAULT_PATH": "/path/to/vault",
        "CURATOR_PROVIDER": "deepseek",
        "CURATOR_MODEL": "deepseek-reasoner"
      }
    }
  }
}
```

**From agent, call MCP tools:**
```
curator_ingest_text({
  text: "Documentation content...",
  source: "my-guide.md",
  area_hint: "backend"
})
```

---

### 4️⃣ HTTP Webhook (n8n / Automation)

**Start with HTTP server:**
```bash
export CURATOR_HTTP_PORT=3099
npx @backendkit-labs/curator-agent curator-watcher
```

**Send documents via HTTP:**
```bash
# Ingest raw text
curl -X POST http://localhost:3099/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "text": "Your document content here...",
    "source": "document-name.md",
    "area_hint": "backend"
  }'

# Ingest from file path
curl -X POST http://localhost:3099/ingest \
  -H "Content-Type: application/json" \
  -d '{
    "file_path": "/absolute/path/to/document.md"
  }'
```

---

### 5️⃣ Programmatic (TypeScript)

```typescript
import { KnowledgeCurator, createProvider } from '@backendkit-labs/curator-agent';

// Using DeepSeek R1 for best technical documentation extraction
const curator = new KnowledgeCurator({
  provider: createProvider({
    provider: 'deepseek',
    apiKey: process.env.CURATOR_API_KEY!,
    model: 'deepseek-reasoner',
  }),
  vaultPath: process.env.CURATOR_VAULT_PATH!,
});

// Process documentation
const result = await curator.curateFile('/path/to/my-docs.md');
console.log(`✓ Created ${result.notesWritten.length} semantic notes`);

// Or curate raw text
const textResult = await curator.curateText('Documentation content...', 'source.md');
console.log(`✓ Processed in ${textResult.durationMs}ms`);
```

---

## MCP Tools Reference

### `curator_ingest_text`
**Curate raw document text into semantic notes**

```json
{
  "text": "Full document content...",
  "source": "document-name.md",
  "area_hint": "backend",
  "provider": "deepseek",
  "model": "deepseek-reasoner"
}
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `text` | string | ✅ | Document content (min 50 chars) |
| `source` | string | ✅ | Source identifier (filename, URL, etc.) |
| `area_hint` | string | ❌ | Helps classify into domain (e.g., `backend`, `commands`, `architecture`) |
| `provider` | string | ❌ | Override default provider for this call |
| `model` | string | ❌ | Override default model for this call |
| `base_url` | string | ❌ | Override API endpoint |
| `vault_path` | string | ❌ | Override vault path |

---

### `curator_ingest_file`
**Read file from disk and curate it**

Automatically moves to `vault/processed/` (success) or `vault/failed/` (error).

```json
{
  "file_path": "/absolute/path/to/document.md",
  "area_hint": "backend"
}
```

| Parameter | Type | Required | Description |
|---|---|---|---|
| `file_path` | string | ✅ | Absolute path to file |
| `area_hint` | string | ❌ | Domain classification hint |
| `provider` | string | ❌ | Override provider |
| `model` | string | ❌ | Override model |

---

### `curator_list_incoming`
**List pending files in `vault/incoming/`**

Returns array of files waiting to be processed.

---

### `curator_process_incoming`
**Batch process all files in `vault/incoming/`**

Accepts same provider/model overrides as other tools. Useful for triggering full curation from automation.

---

## Document Types & Areas

### Tipos (Document Types)

| Type | When to Use | Example |
|---|---|---|
| **guia** | How-to guides, tutorials, step-by-step documentation | "How to use /spec.run" |
| **referencia** | Command reference, API docs, configuration | "Complete /spec commands list" |
| **procedimiento** | Runbook, process flow, workflows | "5-phase spec workflow" |
| **leccion** | Lessons learned, best practices, patterns | "Error handling patterns" |
| **norma_externa** | External standards, regulations, compliance | "DeepSeek API requirements" |

### Areas (Domains)

`backend` · `commands` · `workflow` · `integration` · `architecture` · `learning` · `general`

---

## Output Format

Each document is extracted into multiple **semantic notes** with YAML frontmatter:

### Example: Technical Documentation

**Input:** `03-commands-slash.md` (2000 lines, 50+ commands)

**Output:** Multiple notes like:

```markdown
---
title: "/spec.run — Execute Code Generation"
area: commands
tipo: referencia
resumen: "Execute spec-driven development code generation for current phase; uses LLM specialists and integrated QA review; result saved in phase output"
author: "agent/curator"
date: 2026-06-13
source_ref: "03-commands-slash.md"
tags: ["spec", "commands", "code-generation", "workflow"]
related: ["/spec.next", "/spec.qa", "/spec.advance"]
---

## Command Syntax

```bash
/spec.run
```

## What It Does

Executes code generation for the current spec phase using:
1. Specialist agents (architecture, implementation, testing)
2. Integrated QA review
3. Saves output to phase-specific directory

...rest of extracted content...
```

### Example: Architecture Documentation

**Input:** `14-architecture.md` (Architecture and design)

**Output:** Semantic notes for each component:

```markdown
---
title: "Agent Routing Architecture"
area: architecture
tipo: guia
resumen: "LLM Router analyzes message keywords to select optimal agent; routes to code-generator, architect, reviewer, or debugger based on trigger weights"
tags: ["architecture", "agent-selection", "routing"]
related: ["Agent Specialization", "Intent Detection"]
---

## How Agent Selection Works

The routing system scores each agent based on keyword triggers...
```

---

## Why Reasoning Models Matter

Knowledge extraction is cognitively demanding:

| Task | Regular Model | Reasoning Model |
|------|---|---|
| Extract implicit rules from 10+ pages | ❌ Misses nuance | ✅ Understands context |
| Classify ambiguous document types | ❌ Guesses | ✅ Analyzes intent |
| Write `resumen` dense with searchable terms | ❌ Shallow, generic | ✅ Precise, specific |
| Detect relationships between sections | ❌ No cross-linking | ✅ Finds connections |

**Result:** Reasoning models produce richer semantic notes that improve RAG search recall by 2-3x.

**Recommendation:**
- **Production vaults:** `deepseek-reasoner` (fast + cheap) or `claude-opus-4-8` (highest quality)
- **Quick processing:** `deepseek-chat` (faster, lower cost)
- **Private vault:** Ollama local model (free, offline)

---

## Real-World Example: Processing bk-agent Docs

```bash
# Process 15 technical documentation files
export CURATOR_API_KEY="sk-..."
export CURATOR_VAULT_PATH="/path/to/bk-agent-vault"
export CURATOR_MODEL="deepseek-reasoner"

# Method 1: Watcher (auto-detects new files)
npx @backendkit-labs/curator-agent curator-watcher

# Then drop docs into:
# bk-agent-vault/incoming/
# ├── 03-commands-slash.md
# ├── 04-spec-driven-development.md
# └── ...

# Curator automatically:
# 1. Reads each file
# 2. Extracts semantic notes
# 3. Generates metadata (tags, area, tipo, resumen)
# 4. Writes to vault/
# 5. Moves source to processed/
```

**Result:** 100+ semantic notes, indexed and ready for agent search:
```
vault/
├── Commands
│   ├── spec-run.md
│   ├── spec-advance.md
│   └── ...
├── Workflow
│   ├── 5-phase-roadmap.md
│   └── ...
└── Architecture
    ├── agent-routing.md
    └── ...
```

---

## Troubleshooting

### `.env` File Not Being Loaded

**Problem:** "CURATOR_API_KEY is required"

**Solutions:**

1. **Check .env file exists:**
   ```bash
   # Windows
   Test-Path ".env"
   
   # Linux/Mac
   ls -la .env
   ```

2. **Verify .env format (no quotes):**
   ```env
   # ✅ Correct
   CURATOR_API_KEY=sk-your-key
   CURATOR_VAULT_PATH=/path/to/vault
   
   # ❌ Wrong (don't add quotes)
   CURATOR_API_KEY="sk-your-key"
   CURATOR_VAULT_PATH="/path/to/vault"
   ```

3. **Use correct npm script:**
   ```bash
   # ✅ Correct (loads .env via dotenv)
   npm run watch-vault
   
   # ❌ Wrong (won't load .env)
   npx curator-agent curator-watcher
   ```

4. **Or use node -r dotenv:**
   ```bash
   # Direct command that loads .env
   node -r dotenv/config ./dist/watcher.js
   ```

### API Key Issues

```bash
# Error: Invalid API key
# 1. Check key is correct in .env
cat .env | grep CURATOR_API_KEY

# 2. Make sure no trailing spaces
# 3. Verify it starts with 'sk-'

# 4. Test with curl
curl -H "Authorization: Bearer sk-your-key" \
  https://api.deepseek.com/v1/models
```

**Get your key:**
- **DeepSeek:** https://api.deepseek.com → Create API key
- **OpenAI:** https://platform.openai.com/api-keys
- **Anthropic:** https://console.anthropic.com/dashboard

### Path Issues

```bash
# Error: vault path does not exist
# Make sure path is ABSOLUTE, not relative

# Windows correct: C:\Users\...
# Windows wrong: .\vault or vault/

# Check path exists
Test-Path "C:\Users\mairon.cuello\development\workspace-ia\agent-framework-examples\bk-agent-vault"
```

### Model Not Available

```bash
# Error: Model deepseek-reasoner not found
# Solutions:
# 1. Check API key is valid and has credits
# 2. Try cheaper model: deepseek-chat instead
# 3. Switch providers: CURATOR_PROVIDER=openai CURATOR_MODEL=o3-mini
```

### Files in `failed/` Folder

**Common causes:**
- Invalid API key → Check credentials
- Rate limit → Wait and retry
- Document too large → Split into smaller files
- Malformed text → Check encoding is UTF-8

**Debug:**
```bash
# Check failed file
cat vault/failed/my-doc.md.error

# Retry with different model
CURATOR_MODEL=deepseek-chat npx @backendkit-labs/curator-agent curator-process-incoming
```

---

## Next Steps

1. **Set up environment variables** (see Quick Start)
2. **Create vault structure** (`incoming/`, `processed/`, `failed/`)
3. **Run watcher** or **process single file**
4. **Verify output** in vault folder
5. **Use with knowledge-agent** for RAG search (see [bk-agent documentation](../bk-agent/documentation/15-mcp-knowledge-service-strategy.md))

---

## API Keys & Cost Estimation

| Provider | Cost | Speed | Tokens | Recommendation |
|---|---|---|---|---|
| **DeepSeek** | $0.14 / 1M tokens | Medium | ~2-5k per doc | ✅ **Best value** |
| **OpenAI** | $5-15 / 1M tokens | Fast | ~2-5k per doc | Higher cost |
| **Anthropic** | $15 / 1M tokens | Slower | ~2-5k per doc | Highest quality |
| **Ollama** | Free | Variable | Unlimited | **Best for privacy** |

**For 15 docs (~40k tokens total):** ~$0.005 with DeepSeek

---

## License

MIT
