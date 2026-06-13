# curator-codex-agent

**Codex Curator** — Unified source code and documentation analysis with intelligent knowledge extraction into enterprise vaults using LLM reasoning.

## Overview

`curator-codex-agent` is a **unified curator** that analyzes both source code and documentation:

### 🔵 Code Analysis
Analyzes source code files (TypeScript, JavaScript, Python, Go, Rust, Java, etc.) and extracts:
- **Public APIs** — functions, classes, interfaces, type definitions
- **Modules & Components** — what each file/directory does
- **Patterns & Architecture** — design patterns, integration points
- **Dependencies** — external libraries and internal module relationships
- **Usage Examples** — extracted from comments and associated documentation

### 📄 Documentation Analysis
Processes documentation files (.md, .txt) and extracts:
- **Policies** — company rules, procedures, governance
- **Decisions** — architectural decisions, standards
- **Procedures** — how-to guides, workflows
- **Lessons** — learned experiences, best practices
- **External Standards** — compliance requirements, ISO standards

### Key Features

✅ **Unified Processing** — Handles both source code AND documentation in single pass  
✅ **Multi-language Code** — TypeScript, JavaScript, Python, Go, Rust, Java, C/C++, Kotlin, Swift  
✅ **Smart Documentation Discovery** — automatically finds and combines associated .md files, README.md, and project context  
✅ **Reasoning-based Analysis** — uses deepseek-reasoner for deep understanding of both code and docs  
✅ **Change Detection** — SHA256 manifest tracking, intelligent reprocessing of only changed files  
✅ **Recursive Scanning** — processes entire directory hierarchies, smart ignoring of node_modules, dist, venv, etc.  
✅ **MCP Server** — works as stdio or HTTP server for integration with Claude, bk-agent, other tools  
✅ **Vault Integration** — outputs semantic notes into shared vaults for knowledge sharing  
✅ **Automatic Type Detection** — detects file type and routes to appropriate analyzer

## Installation

```bash
npm install @backendkit-labs/curator-codex-agent
```

Or clone and build:

```bash
cd packages/curator-codex-agent
npm install
npm run build
```

## Usage

### Mode 1: Direct Code Analysis (Single Run)

Analyze a project's code once and generate knowledge vault:

```bash
CURATOR_INPUT_PATH=/path/to/my-project \
CURATOR_OUTPUT_PATH=/path/to/vault \
CURATOR_API_KEY=sk-... \
npm run watch-code
```

This will:
1. Recursively scan `/path/to/my-project` for all code files
2. For each file, search for associated documentation:
   - `filename.md` (same directory)
   - `README.md` (same directory)
   - `docs/filename.md` (in docs/ folder)
   - Root `/README.md` (project context)
3. Analyze code + docs together with reasoning model
4. Extract structured knowledge and write to vault
5. Create `.codex-manifest.json` to track analyzed files
6. Exit

**Second run with same inputs** (after modifying some files):
- Manifest detects unchanged files → skips
- Manifest detects changed files → reanalyzes only those
- Efficiency: if 500 files and only 3 changed, processes only the 3

### Mode 2: Watch Incoming (Autonomous)

Monitor `vault/incoming/` directory for new code files:

```bash
CURATOR_OUTPUT_PATH=/path/to/vault \
CURATOR_API_KEY=sk-... \
npm start
```

Polls every 30 seconds (or `CURATOR_POLL_MS`), processes new code files automatically.

### Mode 3: MCP Server

Run as HTTP MCP server for Claude Desktop or remote clients:

```bash
CURATOR_OUTPUT_PATH=/path/to/vault \
CURATOR_API_KEY=sk-... \
CURATOR_PORT=3101 \
npm start
```

Then use via MCP client:

```typescript
// Analyze a single file
POST http://localhost:3101/mcp
{
  "tool": "analyze_file",
  "params": {
    "file_path": "/absolute/path/to/file.ts",
    "relative_path": "src/services/auth.ts"
  }
}

// Analyze entire directory
POST http://localhost:3101/mcp
{
  "tool": "analyze_directory",
  "params": {
    "directory_path": "/absolute/path/to/project"
  }
}
```

## Configuration

### Environment Variables

**Required:**
- `CURATOR_API_KEY` — Your API key (DeepSeek, OpenAI, Anthropic, etc.)
- `CURATOR_OUTPUT_PATH` — Absolute path to vault root

**Optional:**
- `CURATOR_INPUT_PATH` — Code directory to analyze once (if not set, uses watch mode)
- `CURATOR_PROVIDER` — `deepseek`, `openai`, `anthropic`, `ollama` (default: `deepseek`)
- `CURATOR_MODEL` — Model ID (defaults to reasoning models for each provider)
- `CURATOR_BASE_URL` — Custom LLM endpoint
- `CURATOR_PORT` — HTTP port (if set, runs HTTP MCP; if not, uses stdio)
- `CURATOR_POLL_MS` — Polling interval in milliseconds (default: 30000)

### Example `.env.local`

```env
CURATOR_API_KEY=sk-...
CURATOR_OUTPUT_PATH=/Users/john/Vaults/code-knowledge
CURATOR_INPUT_PATH=/Users/john/Projects/my-framework
CURATOR_PROVIDER=deepseek
CURATOR_MODEL=deepseek-reasoner
```

## Vault Output

For each analyzed file, generates markdown notes with frontmatter:

**File:** `vault/general/2026-06-13-authservice-jwt-based-authentication.md`

```markdown
---
title: "AuthService: JWT-based Authentication"
area: general
tipo: componente
language: typescript
resumen: "NestJS service implementing JWT-based authentication..."
author: "agent/codex"
date: 2026-06-13
source_ref: "src/services/auth.service.ts"
sources_combined: ["src/services/auth.service.ts", "src/services/auth.service.md", "README.md"]
tags: ["code/typescript", "modulo/authentication", "tipo/service", "patron/jwt"]
version: 1.0
depends_on: ["@nestjs/jwt", "@backendkit-labs/result"]
exports: ["AuthService", "login", "validateToken"]
files: ["src/services/auth.service.ts"]
---

## Overview
JWT-based authentication service for NestJS applications.

## Public API

### login(username, password)
...

### validateToken(token)
...

## Dependencies
...
```

### Frontmatter Fields

| Field | Meaning |
|-------|---------|
| `title` | Human-readable name of the analyzed module/component |
| `area` | Category: general, backend, frontend, devops, infraestructura |
| `tipo` | Type: componente, api, patron, utilidad, arquitectura, integracion |
| `language` | Programming language detected |
| `resumen` | 1-2 sentences with searchable terms (function names, types) |
| `source_ref` | Original file analyzed |
| `sources_combined` | Array of files combined (code + associated docs) |
| `tags` | Searchable tags (e.g., code/typescript, modulo/auth) |
| `depends_on` | External dependencies or modules |
| `exports` | Public APIs this file exports |
| `files` | List of files analyzed for this note |

## How It Works

### 1. Discovery

```
Scans INPUT_PATH recursively
↓
Finds ALL files:
  Code:  .ts, .tsx, .js, .jsx, .py, .go, .rs, .java, .c, .cpp, .kt, .swift
  Docs:  .md, .txt
↓
For each code file:
  - Look for filename.md (same dir)
  - Look for README.md (same dir)
  - Look for docs/filename.md
  - Look for root README.md
```

### 2. File Type Detection & Routing

```
Per file, determine type:
  
  IF .md or .txt → Route to DocumentationCurator
    ↓
    Analyzes as: policy, decision, procedure, lesson, standard
    
  IF .ts, .js, .py, etc → Route to CodeAnalyzer
    ↓
    1. Read code (truncate if > 20KB)
    2. Read associated docs (if found)
    3. Send to reasoning model
    4. Extract: APIs, components, patterns, architecture
```

### 3. Analysis

**Code Analysis (CodeAnalyzer):**
```
1. Read code file
2. Find & read associated .md file (if exists)
3. Find & read README.md for context
4. Send ALL THREE to reasoning model
5. LLM extracts: APIs, types, patterns, dependencies
6. Returns structured JSON
```

**Documentation Analysis (DocumentationCurator):**
```
1. Read .md or .txt file
2. Send to LLM
3. LLM extracts: policies, decisions, procedures, lessons
4. Returns structured JSON
```

### 4. Deduplication

```
Check if output file already exists in vault
If yes → skip (avoid duplicate notes)
If no → write new markdown file
```

### 5. Manifest Tracking

```
On first run:
  Creates .codex-manifest.json
  Stores hash of EVERY file (code + docs) + analysis status

On subsequent runs:
  Loads manifest
  Checks hash of each file
  If unchanged → skip analysis
  If changed → reanalyze
  If new → analyze
```

## Example: Analyze a Framework with Code + Documentation

```bash
# Setup
export CURATOR_INPUT_PATH=/Users/john/Projects/my-framework
export CURATOR_OUTPUT_PATH=/Users/john/Vaults/framework-knowledge
export CURATOR_API_KEY=sk-...

# Project structure:
# my-framework/
# ├── src/
# │   ├── auth.service.ts
# │   ├── auth.service.md         ← associated doc
# │   └── payment.ts
# ├── docs/
# │   ├── architecture.md
# │   ├── setup-guide.md
# │   └── contributing.md
# └── README.md

# First run: analyze EVERYTHING (code + docs)
npm run watch-code
# Output: 
#   - 100 code files analyzed (extracted APIs, components)
#   - 10 doc files analyzed (extracted procedures, decisions)
#   - .codex-manifest.json created

# Developer modifies 3 code files + 1 doc
# Second run: only those 4 files reanalyzed
npm run watch-code
# Output: 4 files analyzed, 106 skipped (96% efficiency!)
```

## MCP Integration

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "codex": {
      "command": "npx",
      "args": ["-y", "@backendkit-labs/curator-codex-agent"],
      "env": {
        "CURATOR_API_KEY": "sk-...",
        "CURATOR_OUTPUT_PATH": "/Users/john/Vaults/code-knowledge"
      }
    }
  }
}
```

Then use in Claude:

> I have a folder at `/path/to/my-project`. Can you analyze it and extract knowledge about the architecture and APIs?

### bk-agent

Add to skills or MCP registry:

```yaml
- name: curator-codex
  command: npx @backendkit-labs/curator-codex-agent
  env:
    CURATOR_API_KEY: ${CURATOR_API_KEY}
    CURATOR_OUTPUT_PATH: /shared-vault
```

## Scripts

```bash
npm run build       # Compile TypeScript → dist/
npm run dev         # Run analyzer in dev mode (tsx)
npm start           # Run MCP server (stdio or HTTP)
npm run watch-code  # Analyze code with progress bar
npm run typecheck   # Type checking only
```

## Supported Languages

| Language | Extensions | Example |
|----------|-----------|---------|
| TypeScript | .ts, .tsx | class, interface, type |
| JavaScript | .js, .jsx | function, class, export |
| Python | .py | def, class, async def |
| Go | .go | func, type, interface |
| Rust | .rs | fn, struct, trait, impl |
| Java | .java | class, interface, method |
| C | .c | struct, typedef, void |
| C++ | .cpp | class, namespace, template |
| Kotlin | .kt | class, fun, data class |
| Swift | .swift | class, struct, protocol |

## Unified Architecture

### curator-agent (Documentation Only)
- Specializes in .md and .txt files only
- Extracts: policies, procedures, decisions, standards
- Use when: processing documentation separately

### curator-codex-agent (Unified: Code + Documentation)
- Processes BOTH code files AND .md/.txt files in single pass
- Code Analysis: extracts APIs, components, patterns, architecture
- Documentation Analysis: extracts policies, procedures, decisions, standards
- Automatic File Detection: routes .ts to CodeAnalyzer, .md to DocumentationCurator
- Associated Doc Discovery: finds code.md, README.md, combines with code analysis
- Use when: analyzing projects with mixed code + documentation

### Single vs. Dual Curator Workflows

**Option A: Unified Workflow (Recommended for Projects)**
```
Project/
├── src/          ← Code (.ts, .js, .py)
├── docs/         ← Docs (.md, .txt)
└── README.md

curator-codex-agent INPUT=/project OUTPUT=/vault
  ↓
Processes EVERYTHING in one pass
  ↓
vault/
├── general/
│   ├── authservice-api.md                 (from src/auth.ts + auth.md)
│   ├── architecture-overview.md           (from docs/architecture.md)
│   ├── setup-guide.md                     (from docs/setup.md)
│   └── ...
```

**Option B: Specialized Workflow (Separate Concerns)**
```
curator-codex-agent INPUT=/project/src OUTPUT=/vault    # Code only
curator-agent INPUT=/project/docs OUTPUT=/vault        # Docs only
```

## Troubleshooting

### No manifest found. Will process ALL X files.

Normal on first run. Creates `.codex-manifest.json` to track analyzed files.

### Files showing ⊘ (unchanged)

Good! Manifest detected no hash change. Skipped to save LLM costs. Run with file modifications to reanalyze.

### Model not found error

Check `CURATOR_MODEL` is valid for your provider:
- DeepSeek: `deepseek-reasoner`, `deepseek-chat`
- OpenAI: `o3-mini`, `gpt-4o`, `o1`
- Anthropic: `claude-opus-4-8`, `claude-sonnet-4-6`
- Ollama: `llama3.2`, `qwen2.5-coder:7b`

### API key rejected

Verify `CURATOR_API_KEY` is valid. Check provider's authentication method.

### Memory/timeout on large files

Files > 20KB are truncated to 20KB of code. Increase `maxInputChars` in code if needed:

```typescript
const analyzer = new CodeAnalyzer({
  provider,
  vaultPath,
  maxInputChars: 40_000, // increase limit
});
```

## Performance

| Metric | Baseline |
|--------|----------|
| Analysis per file | 3-8 seconds (reasoning model) |
| Skipped files | < 100ms (hash check only) |
| 500 files, 1st run | ~40-60 minutes (depends on model) |
| 500 files, 2nd run (1% changed) | ~2-3 minutes |
| Vault size (500 files analyzed) | ~50-100 MB |

## License

MIT

## See Also

- [curator-agent](../curator-agent) — Documentation curator
- [bk-agent](../bk-agent) — Multi-agent framework
- [knowledge-agent](../knowledge-agent) — RAG knowledge retrieval
