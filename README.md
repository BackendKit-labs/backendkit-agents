# BackendKit Agents

Production-ready agents built on the [BackendKit Agent Framework](https://github.com/BackendKit-labs/backendkit-agent-framework).

Each agent runs in two modes — no code changes needed:

| Mode | How | Use case |
|---|---|---|
| **MCP stdio plugin** | subprocess inside another agent | Extend `@infrastructure` in your coding assistant |
| **Standalone HTTP MCP server** | long-running process | Shared service across multiple projects/teams |

## Agents

| Package | npm | Description |
|---|---|---|
| [`infra-agent`](packages/infra-agent) | `@backendkit-labs/infra-agent` | Docker, Compose, Swarm, Volumes, Containerd, Kubernetes |

## Usage

### As a plugin (stdio — subprocess)

Add to your agent's `engine.ts`:

```ts
new AgentEngine({
    mcpServers: [
        {
            name: 'infra',
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@backendkit-labs/infra-agent']
        }
    ]
});
```

Or with `create-bk-agent`:

```bash
npx create-bk-agent add plugin infra
```

### As a standalone HTTP MCP server

```bash
npx @backendkit-labs/infra-agent http
# → MCP server on http://localhost:3001/mcp
```

Connect from any agent:

```ts
new AgentEngine({
    mcpServers: [
        { name: 'infra', transport: 'http', url: 'http://infra-agent.internal:3001/mcp' }
    ]
});
```

## Repository structure

```
packages/
  infra-agent/    @backendkit-labs/infra-agent
```

## License

MIT © [BackendKit Labs](https://github.com/BackendKit-labs)
