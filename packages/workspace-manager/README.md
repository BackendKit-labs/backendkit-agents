# Workspace Manager

**Agnóstic workspace manager for curator vaults.** Works with any agent.

## Overview

`workspace-manager` is a standalone MCP server that manages curator vault configurations across agents. Instead of workspace logic being built into each curator implementation, it's a separate service that any agent can use.

## Architecture

```
┌─────────────────────────────────────────────┐
│  .bk-agent/curator-workspace.json           │
│  (global configuration)                     │
└────────────┬────────────────────────────────┘
             │
             ↓
┌─────────────────────────────────────────────┐
│  workspace-manager (MCP Server)             │
│  • workspace_list                           │
│  • workspace_switch                         │
│  • workspace_add/update/remove              │
└────────────┬────────────────────────────────┘
             │
    ┌────────┴────────┬──────────────┐
    ↓                 ↓              ↓
┌────────┐   ┌──────────────┐  ┌──────────┐
│bk-agent│   │Claude Desktop│  │ OpenCode │
└────────┘   └──────────────┘  └──────────┘
```

## Key Differences from Embedded Workspaces

| Aspect | Embedded | Agnóstic |
|--------|----------|----------|
| **Location** | curator-codex-agent | Separate MCP server |
| **Integration** | Coupled | Decoupled |
| **Compatibility** | curator-codex only | Any agent |
| **Deployment** | 1 server | 2 servers (curator + manager) |
| **Configuration** | In MCP server | Shared JSON file |

## Installation & Setup

### 1. Build workspace-manager
```bash
cd packages/workspace-manager
npm install
npm run build
```

### 2. Integrate with bk-agent

Add to `.bk-agent/config.json`:

```json
{
  "mcpServers": [
    {
      "name": "workspace-manager",
      "command": "node",
      "args": ["C:\\path\\to\\workspace-manager\\dist\\server.js"]
    },
    {
      "name": "curator-codex",
      "command": "node",
      "args": ["C:\\path\\to\\curator-codex-agent\\dist\\server.js"],
      "env": {
        "CURATOR_OUTPUT_PATH": "C:\\Users\\mairon\\vaults\\knowledge-vault"
      }
    }
  ]
}
```

### 3. Use Both Together

```bash
# List available workspaces
workspace_list

# Switch workspace (updates .bk-agent/curator-workspace.json)
workspace_switch "backend"

# Curate files (uses current workspace's outputPath)
curator_process_directory "C:\my-project"

# Search in vault (searches current workspace's vault)
knowledge_search "pattern"
```

## Workflow

### Single Session Workflow
```
┌─────────────┐
│ Start       │
└──────┬──────┘
       ↓
┌──────────────────────────┐
│ workspace_list           │ ← See available vaults
└──────┬───────────────────┘
       ↓
┌──────────────────────────┐
│ workspace_switch "name"  │ ← Change active vault
└──────┬───────────────────┘
       ↓
┌──────────────────────────┐
│ curator_process_dir      │ ← Curate files
└──────┬───────────────────┘
       ↓
┌──────────────────────────┐
│ knowledge_search "q"     │ ← Search vault
└──────┬───────────────────┘
       ↓
┌─────────────┐
│ End         │ ← lastUsed persisted
└─────────────┘
```

### Multi-Agent Workflow
```
Claude Desktop
    ↓
workspace_list         ← See workspaces
    ↓
workspace_switch       ← Change workspace
    ├─→ Updates .bk-agent/curator-workspace.json
    │
bk-agent (later)
    ↓
workspace_list         ← Sees updated workspace!
    ↓
curator_process        ← Uses correct vault
```

## Configuration File

Shared across all agents:

```json
{
  "workspaces": [
    {
      "name": "backend",
      "inputPath": "C:\\projects\\backend",
      "outputPath": "C:\\vaults\\vault-backend",
      "description": "Backend APIs and services"
    },
    {
      "name": "security",
      "inputPath": "C:\\projects\\security",
      "outputPath": "C:\\vaults\\vault-security",
      "description": "Security patterns"
    },
    {
      "name": "devops",
      "inputPath": "C:\\projects\\devops",
      "outputPath": "C:\\vaults\\vault-devops",
      "description": "Infrastructure and CI/CD"
    }
  ],
  "lastUsed": "backend",
  "version": "1.0.0"
}
```

## MCP Tools

### workspace_list
List all workspaces and show which is active.

```bash
workspace_list
```

### workspace_current
Show details of the active workspace.

```bash
workspace_current
```

### workspace_switch
Change active workspace.

```bash
workspace_switch "security"
```

### workspace_add
Create or update a workspace.

```bash
workspace_add {
  "name": "frontend",
  "inputPath": "C:\\projects\\frontend",
  "outputPath": "C:\\vaults\\vault-frontend",
  "description": "React components and UI patterns"
}
```

### workspace_remove
Delete a workspace.

```bash
workspace_remove "outdated-vault"
```

## Integration Patterns

### Pattern 1: bk-agent + curator-codex + workspace-manager
```json
{
  "mcpServers": [
    { "name": "workspace-manager", "command": "node", "args": ["..."] },
    { "name": "curator-codex", "command": "node", "args": ["..."] }
  ]
}
```

**Usage:**
```bash
workspace_switch "backend"
curator_process_directory "C:\project"
knowledge_search "query"
```

---

### Pattern 2: Claude Desktop
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

**Usage:**
```
workspace_list
workspace_switch "security"
```

---

### Pattern 3: Multiple Agents Using Same Workspaces
```
Claude Desktop  ←→  .bk-agent/curator-workspace.json  ←→  bk-agent
    │                         (shared)                      │
    └─────────────── workspace-manager ──────────────────┘
```

All agents see the same workspaces because they read/write the same JSON file.

## Error Handling

```bash
# Workspace not found
workspace_switch "nonexistent"
# → { "success": false, "error": "...", "available": ["backend"] }

# No workspace selected
workspace_current
# → { "error": "No workspace selected", "available": [...] }

# Creating duplicate
workspace_add { "name": "backend", ... }
# → { "success": false, "error": "already exists" }
```

## Performance

- **List workspaces**: ~1ms (in-memory)
- **Switch workspace**: ~5ms (JSON file write)
- **File operations**: Synchronous (appropriate for CLI use)

## Security Considerations

- **File permissions**: Ensure `.bk-agent/curator-workspace.json` is readable/writable by agents
- **Path traversal**: Paths are not validated; ensure users only define trusted paths
- **No auth**: workspace-manager has no authentication; assume trusted execution environment

## FAQ

**Q: Why separate from curator-codex?**  
A: Workspaces aren't specific to curation—they're useful for any vault-based workflow. Decoupling allows other agents to use them too.

**Q: Do all agents see the same workspaces?**  
A: Yes. They all read/write the same `.bk-agent/curator-workspace.json` file.

**Q: What if one agent changes workspaces while another is running?**  
A: Both see the change immediately (JSON file is global). curator-codex reads the workspace path at the time it processes files.

**Q: Can I have different workspaces for different agents?**  
A: No, the workspace config is shared. But you can disable workspace-manager for specific agents.

---

**workspace-manager brings agnóstic workspace management to your curator ecosystem.** 🎯
