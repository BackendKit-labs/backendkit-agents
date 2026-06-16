# codex-context-agent — Overview

## Qué es

`codex-context-agent` es un servidor MCP (Model Context Protocol) que actúa como memoria de conocimiento por proyecto para agentes de codificación. Permite a Claude Code, Cursor, Windsurf o cualquier cliente MCP:

- **Curar** archivos de código y documentación con un LLM para extraer conocimiento estructurado
- **Buscar** ese conocimiento semánticamente (RAG) durante el desarrollo
- **Leer** notas curadas específicas cuando las necesita

## Por qué existe

Los agentes de codificación pierden contexto entre sesiones. Cada vez que empezás una nueva conversación con Claude Code, el agente no sabe nada del proyecto — qué hace el `AuthService`, qué patrón de errores se usa, qué dependencias tiene cada módulo.

`codex-context-agent` resuelve esto creando un **vault persistente por proyecto**: un directorio de notas Markdown con frontmatter estructurado que el agente puede indexar y consultar semánticamente en cualquier momento.

## Diferencias con curator-codex-agent

| | curator-codex-agent | codex-context-agent |
|---|---|---|
| Audiencia | Equipos enterprise | Agentes de codificación |
| Config | Workspace JSON manual | Auto-detecta git root |
| Tools | 11 (workspace management incluido) | 4 (solo lo esencial) |
| HTTP API | Express completo + seguridad | Solo transporte HTTP opcional |
| PDF | No | Sí |
| Provider default | deepseek-reasoner | deepseek-reasoner |

## Flujo de alto nivel

```
1. Claude Code arranca
         ↓
2. codex-context-agent detecta git root del CWD
         ↓
3. Vault se crea en ~/.codex-vaults/{proyecto}/
         ↓
4. Claude Code puede llamar curate_path(ruta)
         ↓
5. Analizador extrae conocimiento con LLM
         ↓
6. Notas .md guardadas en el vault
         ↓
7. Claude Code llama search_vault("pregunta")
         ↓
8. RAG retorna notas relevantes + síntesis
```

## Casos de uso principales

### Durante onboarding a un proyecto nuevo
```
curate_path("/project/src")
→ procesa todos los archivos en background
→ vault queda con conocimiento de cada módulo
```

### Durante desarrollo activo
```
search_vault("cómo funciona el sistema de autenticación")
→ retorna notas sobre AuthService, JWT, middleware
→ síntesis automática combinando múltiples fuentes
```

### Al agregar un archivo nuevo
```
curate_path("/project/src/payments/stripe.service.ts")
vault_status({ reload: true })
→ el archivo queda indexado para búsquedas futuras
```

### Consultando documentación curada
```
curate_path("/project/docs/arquitectura.pdf")
search_vault("decisiones de arquitectura")
```

## Vault como fuente de verdad

El vault no es cache — es una **base de conocimiento durable**. Las notas curadas sobreviven entre sesiones, entre actualizaciones del modelo, y entre reinstalaciones. Son Markdown puro con frontmatter YAML, legibles por cualquier herramienta (Obsidian, VS Code, grep).

El índice RAG (en `~/.codex-context/rag/`) sí es regenerable — si se borra, un `vault_status({ reload: true })` lo reconstruye desde las notas existentes.
