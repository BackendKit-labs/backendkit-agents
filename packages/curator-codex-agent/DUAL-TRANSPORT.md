# Curator-Codex: Dual-Transport MCP Server

Unified MCP server with **Stdio + HTTP transports** for maximum flexibility.

## 🎯 Architecture

```
curator-codex-agent server
├── MCP Stdio Transport (always active)
│   ├── Local agents (bk-agent, bk-agent-framework)
│   ├── Claude Desktop (register in config)
│   └── Child processes (spawn & communicate)
│
└── MCP HTTP Transport (optional, via CURATOR_HTTP_PORT)
    ├── Remote clients
    ├── External tools (OpenCode, etc)
    └── Proxy/gateway scenarios
```

**Both transports can run simultaneously.**

## 🚀 Usage Modes

### Mode 1: Stdio Only (Default)

For Claude Desktop or local agent embedding.

```bash
# Start with stdio
export CURATOR_OUTPUT_PATH=/path/to/vault
export CURATOR_API_KEY=sk-...
npm start

# Output:
# [codex] Vault:     /path/to/vault
# [codex] Model:     deepseek-reasoner
# [codex] ✓ Stdio MCP transport ready
# [codex] Ready for connections
```

**Register in Claude Desktop config:**
```json
{
  "mcpServers": {
    "curator-codex": {
      "command": "npx",
      "args": ["-y", "@backendkit-labs/curator-codex-agent"],
      "env": {
        "CURATOR_API_KEY": "sk-...",
        "CURATOR_OUTPUT_PATH": "/path/to/vault"
      }
    }
  }
}
```

### Mode 2: Stdio + HTTP (Hybrid)

For local embedding + remote clients.

```bash
# Start with both transports
export CURATOR_OUTPUT_PATH=/path/to/vault
export CURATOR_API_KEY=sk-...
export CURATOR_HTTP_PORT=3101
npm start

# Output:
# [codex] ✓ Stdio MCP transport ready
# [codex] ✓ HTTP MCP transport on http://localhost:3101/mcp
# [codex] Ready for connections
```

**Now you can use it both ways:**

```bash
# Via HTTP from external tools
curl -X POST http://localhost:3101/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "curator_process_directory",
      "arguments": {"directory_path": "/path/to/code"}
    },
    "id": 1
  }'

# Via Stdio from Claude Desktop (same process)
# No extra configuration needed
```

### Mode 3: HTTP Only (Daemon)

For server deployments.

```bash
# In production, wrap with systemd/docker
CURATOR_HTTP_PORT=3101 CURATOR_OUTPUT_PATH=/vault npm start

# HTTP available on http://localhost:3101/mcp
# Stdio still active but not used (clients can still connect)
```

## 📡 MCP Tools Available

All tools work on both transports:

### `curator_process_file`
Analyze a single file (code or documentation).

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "curator_process_file",
    "arguments": {
      "file_path": "/path/to/file.ts",
      "relative_path": "src/services/auth.ts"
    }
  },
  "id": 1
}
```

### `curator_process_directory`
Recursively analyze entire directory.

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "curator_process_directory",
    "arguments": {
      "directory_path": "/path/to/project"
    }
  },
  "id": 1
}
```

Returns:
```json
{
  "notesWritten": [...],
  "notesSkipped": [...],
  "errors": [...],
  "filesAnalyzed": [...],
  "totalFiles": 150,
  "codeFiles": 100,
  "docFiles": 50,
  "durationMs": 15420
}
```

### `curator_vault_status`
Get vault information.

```json
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "curator_vault_status",
    "arguments": {}
  },
  "id": 1
}
```

## 🔄 Integration Examples

### Example 1: bk-agent (Embedded)

```typescript
// bk-agent can spawn curator-codex as child process
// Uses stdio MCP transport automatically
// No server startup needed, embedded in bk-agent

const curator = spawn('npm', ['start'], {
  env: {
    CURATOR_OUTPUT_PATH: '/vault',
    CURATOR_API_KEY: 'sk-...'
  }
});

// Use tools:
agent.tools['curator_process_directory']({
  directory_path: '/my/project'
});
```

### Example 2: Claude Desktop + Remote Sync

```bash
# Start curator-codex with HTTP
CURATOR_HTTP_PORT=3101 \
CURATOR_OUTPUT_PATH=/vault \
npm start &

# Claude Desktop connects via stdio (local)
# Remote service connects via HTTP
curl -X POST http://localhost:3101/mcp \
  -H "Content-Type: application/json" \
  -d '...'
```

### Example 3: Docker/Kubernetes

```dockerfile
FROM node:20
WORKDIR /app
COPY . .
RUN npm install && npm run build

EXPOSE 3101
ENV CURATOR_HTTP_PORT=3101
ENV CURATOR_OUTPUT_PATH=/vault

CMD ["npm", "start"]
```

```yaml
# kubernetes deployment
apiVersion: apps/v1
kind: Deployment
metadata:
  name: curator-codex
spec:
  replicas: 1
  template:
    spec:
      containers:
      - name: curator-codex
        image: curator-codex:latest
        ports:
        - containerPort: 3101
        env:
        - name: CURATOR_HTTP_PORT
          value: "3101"
        - name: CURATOR_OUTPUT_PATH
          value: "/vault"
        - name: CURATOR_API_KEY
          valueFrom:
            secretKeyRef:
              name: curator-secrets
              key: api-key
```

## 🎯 Decision Matrix

| Scenario | Use | Command |
|----------|-----|---------|
| Claude Desktop only | Stdio | `npm start` |
| bk-agent embedding | Stdio | `npm start` |
| Claude + remote tools | Both | `CURATOR_HTTP_PORT=3101 npm start` |
| Production API | HTTP | `CURATOR_HTTP_PORT=3101 npm start` |
| Kubernetes/Docker | HTTP | `CURATOR_HTTP_PORT=3101 npm start` |

## 📋 Environment Variables

| Variable | Value | When to Set |
|----------|-------|-------------|
| `CURATOR_API_KEY` | `sk-...` | Always required |
| `CURATOR_OUTPUT_PATH` | `/path/to/vault` | Always required |
| `CURATOR_HTTP_PORT` | `3101` | When using HTTP transport |
| `CURATOR_MODEL` | `deepseek-reasoner` | Optional (override default) |
| `CURATOR_BASE_URL` | Custom URL | Optional (custom LLM endpoint) |

## 🔍 Monitoring

### Check Status

```bash
# If HTTP is enabled, check health
curl http://localhost:3101/mcp -X OPTIONS -v

# Or test with a tool call
curl -X POST http://localhost:3101/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","params":{"name":"curator_vault_status","arguments":{}},"id":1}'
```

### Log Output

```
[codex] ✓ Stdio MCP transport ready
[codex] ✓ HTTP MCP transport on http://localhost:3101/mcp
[codex] Ready for connections
```

## 🚀 Next: Paso 2 - RAG Integration

Once curator-codex is running (either mode), Paso 2 adds:
- Semantic search (`/knowledge/search` MCP tool)
- RAG indexing (`/vault/reload` MCP tool)
- Synthesis generation (automatic note creation)

All tools work on both stdio and HTTP transports.

## 💡 Best Practices

1. **Development**: Use stdio mode
   ```bash
   npm start
   ```

2. **Testing multiple transports**: Use hybrid mode
   ```bash
   CURATOR_HTTP_PORT=3101 npm start
   ```

3. **Production**: Run as systemd service/Docker with HTTP
   ```bash
   CURATOR_HTTP_PORT=3101 npm start
   ```

4. **Security**: Don't expose HTTP without auth (Paso 3 will add this)

5. **Monitoring**: Use health checks on HTTP transport
