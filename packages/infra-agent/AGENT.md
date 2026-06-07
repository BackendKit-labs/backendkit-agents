# AGENT.md — Docker Agent

## Commands
- Install: `npm install`
- Build: `npm run build`
- Dev: `npm run dev`
- Test: `npm test`
- Lint: `npm run lint`

## Stack
Node.js 20+, TypeScript 5.7+, @bk/agent-core (backendkit-agent-framework), dockerode, Docker Compose CLI, Jest + testcontainers-node

## Architecture
3 capas: (1) AgentEngine (@bk/agent-core) maneja ciclo de vida, ToolRegistry, AgentRegistry y DelegationBus para comunicación entre agentes, (2) Tools layer expone operaciones Docker como ToolDefinitions (ContainerManager, ComposeManager, SystemManager), (3) Docker SDK Layer abstrae dockerode y child_process para Compose.

## Conventions
- Nombres de tools: `dominio.accion` (ej: `container.create`, `compose.up`)
- Archivos TypeScript: camelCase para archivos, PascalCase para clases/interfaces
- Tests: un archivo por tool (`container.test.ts`, `compose.test.ts`)
- Interfaces para specs de entrada, interfaces para resultados
- Errores: jerarquía con clase base `DockerAgentError`

## Do NOT touch
- `compose-files/` templates sin aprobación del equipo
- `prompt.md` — especificación original del proyecto
- Archivos de configuración del framework @bk/agent-core fuera de `src/`

## Current phase
Phase 1 — MVP: Core Tools + Contenedores Individuales

## Key documents
- design.md — architecture overview, tech stack, key decisions (C4 Level 1)
- specification.md — API contracts, data models, business logic
- security.md — threat model, auth design, OWASP checklist, security requirements
- roadmap.md — phased delivery plan with objectives and definitions of done
