# backendkit-agents — Contexto del proyecto

## Vault de conocimiento — leer primero

Este proyecto tiene un vault activo con notas curadas del código y la documentación. **Antes de explorar archivos o hacer greps, buscá en el vault:**

```
search_vault("tu pregunta en lenguaje natural")
```

Flujo en cada sesión:
1. `search_vault(...)` — orientación rápida sobre el área de trabajo
2. `read_note("título")` — detalle completo de una nota específica
3. Trabajar en el código
4. `curate_path("archivo modificado")` — actualizar el vault después de cambios

El vault persiste entre sesiones y se reindexea automáticamente después de cada `curate_path`. Solo usá `vault_status({ reload: true })` si agregaste notas manualmente o necesitás forzar una reconstrucción.

## Qué es este repo

Monorepo de agentes MCP (Model Context Protocol) para la plataforma BackendKit. Cada paquete en `packages/` es un servidor MCP independiente.

```
packages/
├── codex-context-agent/     ← ACTIVO: vault de conocimiento por proyecto
├── curator-codex-agent/     ← Original del que se forkeó codex-context-agent
├── orchestrator-mcp-agent/  ← Orquestador de agentes
├── curator-agent/           ← Curador de documentación enterprise
├── knowledge-agent/         ← Agente de conocimiento base
├── design-agent/            ← Agente de diseño
├── docker-agent/            ← Agente Docker
├── k8s-agent/               ← Agente Kubernetes
└── workspace-manager/       ← Gestión de workspaces
```

## codex-context-agent — Estado actual

### Qué hace
Servidor MCP que genera y consulta un vault de conocimiento por proyecto. Analiza código (.ts, .js, .py, .go, .rs, .java, etc.), documentación (.md, .txt) y PDFs con un LLM, guarda notas estructuradas en Markdown, y las expone vía búsqueda semántica (RAG).

### 4 tools MCP
- `curate_path(path)` — analiza archivo o directorio → notas en vault
- `search_vault(query, topK?, autoSynthesize?)` — búsqueda semántica RAG
- `read_note(path_or_title)` — leer nota por título o path
- `vault_status(reload?)` — estado del vault, opcionalmente reindexar

### Vault
Se crea automáticamente en `~/.codex-vaults/{nombre-del-repo}/` detectando el git root.

### Configuración MCP activa
- Settings: `.claude/settings.json` (committed) + `.claude/settings.local.json` (gitignored, tiene la API key)
- Provider: DeepSeek / deepseek-reasoner
- Dist compilado: `packages/codex-context-agent/dist/server.js`

### Documentación del agente
Está en `packages/codex-context-agent/docs/` — 9 archivos .md con:
- `overview.md` — qué es y por qué existe
- `architecture.md` — módulos y flujos de datos
- `mcp-tools.md` — referencia completa de tools
- `configuration.md` — env vars y proveedores
- `vault-structure.md` — formato de notas y frontmatter
- `rag-search.md` — cómo funciona el RAG internamente
- `pdf-support.md` — extracción de texto PDF
- `project-detection.md` — detección de git root
- `workflows.md` — patrones de uso

### Estado del vault
- 45+ notas curadas: docs de `packages/codex-context-agent/docs/` + código de `src/`
- Embeddings: `nomic-embed-text` vía Ollama (semántico real, no TF-IDF)
- Índice: `~/.codex-context/rag/backendkit-agents.json`

## Comandos útiles

```bash
# Build codex-context-agent
cd packages/codex-context-agent && npm run build

# Correr manualmente (sin Claude Code)
CODEX_API_KEY=sk-... node packages/codex-context-agent/dist/server.js

# Build todo el monorepo
npm run build
```

## Stack técnico

- TypeScript + NodeNext modules
- MCP SDK: `@modelcontextprotocol/sdk`
- RAG: `@backendkit-labs/agent-enterprise` (ObsidianRAGProvider + OllamaEmbedder / nomic-embed-text)
- LLM adapters: OpenAI-compatible + Anthropic SDK
- PDF: `pdf-parse` v2 con `pdfjs-dist`
- Transporte: stdio (siempre) + HTTP opcional (StreamableHTTPServerTransport)
