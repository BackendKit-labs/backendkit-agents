# Curator-Codex HTTP API

Unified HTTP server for code + documentation curation and knowledge management.

## Quick Start

```bash
# Start the HTTP server
export CURATOR_OUTPUT_PATH=/path/to/vault
export CURATOR_API_KEY=sk-...
npm run http-server

# Server runs on http://localhost:3100
```

## API Endpoints

### System

#### `GET /`
Server info and available endpoints.

```bash
curl http://localhost:3100/
```

#### `GET /health`
Health check for monitoring.

```bash
curl http://localhost:3100/health
```

#### `GET /status`
Current configuration and status.

```bash
curl http://localhost:3100/status
```

### Configuration

#### `GET /curator/config`
Get current curator configuration.

```bash
curl http://localhost:3100/curator/config
```

Response:
```json
{
  "inputPath": "/path/to/project",
  "outputPath": "/path/to/vault",
  "provider": "deepseek",
  "model": "deepseek-reasoner",
  "port": 3100
}
```

#### `POST /curator/config`
Set curator input and output paths.

```bash
curl -X POST http://localhost:3100/curator/config \
  -H "Content-Type: application/json" \
  -d '{
    "inputPath": "/path/to/project",
    "outputPath": "/path/to/vault"
  }'
```

### Curation

#### `POST /curator/process`
Curate files from input path into vault.

```bash
# Option 1: Use paths from config
curl -X POST http://localhost:3100/curator/process

# Option 2: Specify paths in request
curl -X POST http://localhost:3100/curator/process \
  -H "Content-Type: application/json" \
  -d '{
    "inputPath": "/path/to/project",
    "outputPath": "/path/to/vault"
  }'
```

Response:
```json
{
  "notesWritten": [
    "/path/to/vault/general/2026-06-13-authservice-api.md",
    "/path/to/vault/backend/2026-06-13-payment-service.md"
  ],
  "notesSkipped": ["2026-06-13-existing-note.md"],
  "errors": [],
  "filesAnalyzed": [
    "src/services/auth.service.ts",
    "src/services/payment.service.ts",
    "docs/architecture.md"
  ],
  "totalFiles": 3,
  "codeFiles": 2,
  "docFiles": 1,
  "durationMs": 15420
}
```

## Usage Examples

### Example 1: Basic Curation Flow

```bash
# 1. Start server
export CURATOR_OUTPUT_PATH=/Users/john/vaults/project-knowledge
export CURATOR_API_KEY=sk-...
npm run http-server
# Server listening on http://localhost:3100

# 2. Configure input path
curl -X POST http://localhost:3100/curator/config \
  -H "Content-Type: application/json" \
  -d '{
    "inputPath": "/Users/john/Projects/my-backend",
    "outputPath": "/Users/john/vaults/project-knowledge"
  }'

# 3. Curate files
curl -X POST http://localhost:3100/curator/process

# Response: 100 notes written, 0 errors
```

### Example 2: Add New Domain Later

```bash
# 1. Server still running from before
# 2. Update input path to new domain
curl -X POST http://localhost:3100/curator/config \
  -H "Content-Type: application/json" \
  -d '{
    "inputPath": "/Users/john/compliance-docs",
    "outputPath": "/Users/john/vaults/project-knowledge"
  }'

# 3. Curate new domain
curl -X POST http://localhost:3100/curator/process

# Response: 50 new notes written
# Vault now has 150 notes total
```

### Example 3: Using with External Tools

```python
# Python client example
import requests

API_BASE = "http://localhost:3100"

# Configure
response = requests.post(f"{API_BASE}/curator/config", json={
    "inputPath": "/path/to/code",
    "outputPath": "/path/to/vault"
})
print(response.json())

# Curate
response = requests.post(f"{API_BASE}/curator/process")
result = response.json()
print(f"Notes written: {len(result['notesWritten'])}")
print(f"Errors: {result['errors']}")
```

## Environment Variables

### Required
- `CURATOR_API_KEY` — LLM API key (DeepSeek, OpenAI, etc.)
- `CURATOR_OUTPUT_PATH` — Absolute path to vault root

### Optional
- `CURATOR_INPUT_PATH` — Code/doc directory (can also be set via API)
- `CURATOR_HTTP_PORT` — Server port (default: 3100)
- `CURATOR_PROVIDER` — LLM provider: deepseek, openai, anthropic, ollama (default: deepseek)
- `CURATOR_MODEL` — Model ID (default: deepseek-reasoner)
- `CURATOR_BASE_URL` — Custom LLM endpoint

## Response Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 400 | Bad request (missing fields, invalid input) |
| 404 | Route not found |
| 500 | Server error |

## Files Processed

The API automatically detects and processes:

**Code Files:**
- `.ts`, `.tsx` (TypeScript)
- `.js`, `.jsx` (JavaScript)
- `.py` (Python)
- `.go` (Go)
- `.rs` (Rust)
- `.java` (Java)
- `.c`, `.cpp` (C/C++)
- `.kt` (Kotlin)
- `.swift` (Swift)

**Documentation Files:**
- `.md` (Markdown)
- `.txt` (Text)

## Manifest Tracking

The API automatically creates `.codex-manifest.json` in the input directory to:
- Track file hashes
- Skip unchanged files on subsequent runs
- Enable efficient incremental curation

Subsequent runs only analyze changed files.

## Next Steps

- **Paso 2:** Add `/knowledge/*` endpoints for RAG search
- **Paso 3:** Implement synthesis and semantic indexing
- **Paso 4:** Add MCP tools for Claude, bk-agent, OpenCode

## Troubleshooting

### Server won't start
```
✗ CURATOR_OUTPUT_PATH is required
```
Set the environment variable:
```bash
export CURATOR_OUTPUT_PATH=/path/to/vault
npm run http-server
```

### No files found
The input directory may not exist or contain no code/doc files.
Check the path:
```bash
curl http://localhost:3100/status
```

### Files not being curated
Check if they match supported extensions (see "Files Processed" section above).
