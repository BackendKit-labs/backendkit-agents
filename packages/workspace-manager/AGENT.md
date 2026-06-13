# Workspace Manager — Agnóstic MCP Server

**Workspace Manager** is an agnóstic MCP server that manages curator vaults across any agent.

## Features

✅ **List workspaces** — See all configured vaults  
✅ **Switch workspace** — Change active vault globally  
✅ **Create workspace** — Add new vault configurations  
✅ **Update workspace** — Modify existing vault paths  
✅ **Remove workspace** — Delete vault configurations  
✅ **Agnóstic** — Works with bk-agent, Claude Desktop, OpenCode, etc.

## Installation

```bash
cd packages/workspace-manager
npm install
npm run build
```

## Integration

### bk-agent

Add to `.bk-agent/config.json`:

```json
{
  "mcpServers": [
    {
      "name": "workspace-manager",
      "command": "node",
      "args": ["C:\\path\\to\\workspace-manager\\dist\\server.js"]
    }
  ]
}
```

### Claude Desktop

Add to Claude Desktop config:

```json
{
  "mcpServers": {
    "workspace-manager": {
      "command": "node",
      "args": ["C:\\path\\to\\workspace-manager\\dist\\server.js"]
    }
  }
}
```

### Any MCP Client

```bash
node dist/server.js
```

## MCP Tools

### `workspace_list`
List all workspaces and show current active one.

```bash
workspace_list
```

**Response:**
```json
{
  "current": "backend",
  "workspaces": [
    {
      "name": "backend",
      "inputPath": "C:\\...",
      "outputPath": "C:\\vaults\\vault-backend",
      "description": "Backend projects",
      "active": true
    },
    {
      "name": "security",
      "inputPath": "C:\\...",
      "outputPath": "C:\\vaults\\vault-security",
      "description": "Security patterns",
      "active": false
    }
  ]
}
```

---

### `workspace_current`
Get details of the currently active workspace.

```bash
workspace_current
```

**Response:**
```json
{
  "name": "backend",
  "workspace": {
    "name": "backend",
    "inputPath": "C:\\...",
    "outputPath": "C:\\vaults\\vault-backend",
    "description": "Backend projects"
  }
}
```

---

### `workspace_switch`
Switch to a different workspace.

```bash
workspace_switch "security"
```

**Response:**
```json
{
  "success": true,
  "workspace": {
    "name": "security",
    "inputPath": "C:\\...",
    "outputPath": "C:\\vaults\\vault-security",
    "description": "Security patterns"
  },
  "message": "Switched to workspace: security"
}
```

---

### `workspace_add`
Create a new workspace or update an existing one.

```bash
workspace_add {
  "name": "devops",
  "inputPath": "C:\\Users\\mairon\\development\\devops",
  "outputPath": "C:\\Users\\mairon\\vaults\\vault-devops",
  "description": "DevOps and infrastructure"
}
```

**Response:**
```json
{
  "success": true,
  "action": "created",
  "workspace": {
    "name": "devops",
    "inputPath": "C:\\...",
    "outputPath": "C:\\...",
    "description": "DevOps and infrastructure"
  }
}
```

---

### `workspace_remove`
Delete a workspace from the configuration.

```bash
workspace_remove "security"
```

**Response:**
```json
{
  "success": true,
  "removed": "security",
  "remaining": ["backend", "devops"]
}
```

---

## Typical Workflow

```bash
# 1. List available workspaces
workspace_list

# 2. See current active workspace
workspace_current

# 3. Switch to a different workspace
workspace_switch "security"

# 4. Create a new workspace
workspace_add {
  "name": "frontend",
  "inputPath": "C:\\projects\\frontend",
  "outputPath": "C:\\vaults\\vault-frontend"
}

# 5. Use with curator-codex
curator_process_directory "C:\\my-project"
# → Files are curated into the current workspace's outputPath

# 6. Search in current workspace
knowledge_search "query"
# → Searches only the current workspace's vault
```

## Configuration File

Workspaces are stored in `.bk-agent/curator-workspace.json`:

```json
{
  "workspaces": [
    {
      "name": "backend",
      "inputPath": "C:\\...",
      "outputPath": "C:\\vaults\\vault-backend",
      "description": "Backend projects and patterns"
    },
    {
      "name": "security",
      "inputPath": "C:\\...",
      "outputPath": "C:\\vaults\\vault-security",
      "description": "Security patterns and best practices"
    }
  ],
  "lastUsed": "backend",
  "version": "1.0.0"
}
```

## Use Cases

| Scenario | Commands |
|----------|----------|
| Switch between vaults | `workspace_list` → `workspace_switch "name"` |
| Organize by domain | Create: backend, security, frontend, devops |
| Collaborate | Share curator-workspace.json with team |
| Audit | See who uses which workspace via `lastUsed` |
| Automation | Call `workspace_switch` before `curator_process` |

## Compatibility

Works with any agent that supports MCP:

- ✅ bk-agent
- ✅ Claude Desktop
- ✅ OpenCode
- ✅ LM Studio
- ✅ Any custom MCP client

## Error Handling

```bash
# Workspace not found
workspace_switch "nonexistent"

# Response:
{
  "success": false,
  "error": "Workspace \"nonexistent\" not found",
  "available": ["backend", "security"]
}
```

---

**Workspace Manager is agnóstic and integrates seamlessly with any curator-based workflow.** 🎯
