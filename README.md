# BackendKit Agents

Production-ready MCP plugins built on the [BackendKit Agent Framework](https://github.com/BackendKit-labs/backendkit-agent-framework).

Each plugin runs in two modes — no code changes needed:

| Mode | How | Use case |
|---|---|---|
| **MCP stdio plugin** | subprocess inside another agent | Extend your coding assistant |
| **Standalone HTTP MCP server** | long-running process | Shared service across multiple projects/teams |

## Agents

| Package | npm | Description |
|---|---|---|
| [`docker-agent`](packages/docker-agent) | `@backendkit-labs/docker-agent` | Docker, Compose, Swarm, volumes, networks, registry, build |
| [`k8s-agent`](packages/k8s-agent) | `@backendkit-labs/k8s-agent` | Kubernetes — apply manifests, inspect resources, logs, exec |
| [`design-agent`](packages/design-agent) | `@backendkit-labs/design-agent` | Spec-driven design lifecycle — roadmap, phases (spec→implement→verify), multi-project overview |

## Usage

### As a stdio plugin (subprocess inside another agent)

```ts
new AgentEngine({
    mcpServers: [
        {
            name: 'docker',
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@backendkit-labs/docker-agent']
        },
        {
            name: 'design',
            transport: 'stdio',
            command: 'npx',
            args: ['-y', '@backendkit-labs/design-agent'],
            env: { BK_APP_NAME: 'my-agent' }
        }
    ]
});
```

### As a standalone HTTP MCP server

```bash
npx @backendkit-labs/docker-agent http
# → MCP server on http://localhost:3001/mcp
```

Connect from any MCP-compatible client:

```ts
new AgentEngine({
    mcpServers: [
        { name: 'docker', transport: 'http', url: 'http://docker-agent.internal:3001/mcp' }
    ]
});
```

## design-agent — spec-driven development

The `design-agent` enforces a **spec → implement → verify** loop per phase, preventing agents from skipping design or leaving work half-done.

```
Phase 1: Auth Module
  📐 SPEC      → write interfaces, types, test cases
  🔨 IMPLEMENT → build to satisfy the spec
  ✅ VERIFY    → run tests, confirm all criteria pass
```

**Document tools** (write to project cwd, tracked in git):
`design_save_prompt`, `design_save_docs`, `design_read_context`

**Execution tools** (lifecycle state machine):
`design_init`, `design_status`, `design_next`, `design_advance`, `design_edit`, `design_overview`

Execution state is persisted in `~/.{appName}/projects/{key}/design.json`.
Design documents (`prompt.md`, `specification.md`, `design.md`, `AGENT.md`, `ROADMAP.md`) live in the project directory.

## Repository structure

```
packages/
  docker-agent/    @backendkit-labs/docker-agent
  k8s-agent/       @backendkit-labs/k8s-agent
  design-agent/    @backendkit-labs/design-agent
```

## License

MIT © [BackendKit Labs](https://github.com/BackendKit-labs)
