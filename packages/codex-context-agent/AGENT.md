# codex-context-agent

Agente MCP que genera y consulta un vault de conocimiento por proyecto. Analiza código y documentación con un LLM, guarda notas estructuradas en Markdown, y las expone vía búsqueda semántica (RAG).

Diseñado para conectarse a **Claude Code**, Cursor, Windsurf, o cualquier cliente MCP.

---

## Cómo funciona

```
Tus archivos (código / docs / PDFs)
        ↓ curate_path
    CodeAnalyzer / DocumentationCurator
        ↓ LLM (DeepSeek / Claude / OpenAI / Ollama)
    Notas estructuradas (.md con frontmatter)
        ↓ guardadas en
    ~/.codex-vaults/{nombre-del-repo}/
        ↓ indexadas con embeddings
    search_vault("cómo funciona X?")
        ↓
    Top-K resultados + síntesis automática
```

El vault se detecta automáticamente desde el **git root** del proyecto activo. No requiere configuración por proyecto más allá de la API key.

---

## Instalación

```bash
# Desde el monorepo backendkit-agents
cd packages/codex-context-agent
npm install
npm run build
```

---

## Configuración en Claude Code

### Estructura de archivos

```
tu-proyecto/
└── .claude/
    ├── settings.json        # Committed — config del servidor MCP
    └── settings.local.json  # Gitignored — API key y overrides locales
```

Claude Code carga ambos archivos y los fusiona. Nunca commitees `settings.local.json`.

---

### settings.json (committed al repo)

```json
{
  "mcpServers": {
    "codex-context": {
      "command": "node",
      "args": [
        "/ruta/absoluta/a/packages/codex-context-agent/dist/server.js"
      ],
      "env": {
        "CODEX_PROJECT_PATH": "/ruta/absoluta/a/tu-proyecto"
      }
    }
  }
}
```

`CODEX_PROJECT_PATH` fija el proyecto para este vault. Si lo omitís, el agente usa el CWD al arrancar (funciona bien si siempre abrís Claude Code desde la raíz del repo).

---

### settings.local.json (gitignored — tu máquina)

```json
{
  "mcpServers": {
    "codex-context": {
      "env": {
        "CODEX_API_KEY": "sk-tu-key-aqui",
        "CODEX_PROVIDER": "deepseek"
      }
    }
  }
}
```

Las claves de `env` en `settings.local.json` se fusionan con las de `settings.json`, así que solo necesitás poner lo que es local/secreto.

---

### Variables de entorno

| Variable | Requerida | Default | Descripción |
|---|---|---|---|
| `CODEX_API_KEY` | Sí | — | API key del proveedor LLM |
| `CODEX_PROJECT_PATH` | No | CWD del proceso | Raíz del proyecto (fija el vault) |
| `CODEX_PROVIDER` | No | `deepseek` | Proveedor LLM |
| `CODEX_MODEL` | No | Default del proveedor | Modelo específico |
| `CODEX_BASE_URL` | No | Default del proveedor | Endpoint personalizado |
| `CODEX_HTTP_PORT` | No | — | Activa transporte HTTP en ese puerto |

---

### Proveedores soportados

| `CODEX_PROVIDER` | Default model | Notas |
|---|---|---|
| `deepseek` | `deepseek-reasoner` | Recomendado — mejor costo/calidad para análisis de código |
| `openai` | `o3-mini` | Compatible con cualquier endpoint OpenAI |
| `anthropic` | `claude-sonnet-4-6` | Claude directo |
| `ollama` | `qwen2.5-coder:7b` | Local, sin costo, requiere Ollama corriendo |

Para Ollama no necesitás `CODEX_API_KEY` (podés poner cualquier string).

---

## Vault

El vault se crea automáticamente en:

```
~/.codex-vaults/{nombre-del-repo}/
├── general/          # Notas sin categoría específica
├── backend/          # Código de backend
├── frontend/         # Código de frontend
├── devops/           # Infraestructura, CI/CD
├── infraestructura/  # Cloud, configuración
├── synthesis/        # Notas sintéticas generadas por search_vault
└── general/          # Docs curadas (.md, .txt, .pdf)
```

Cada nota es un `.md` con frontmatter YAML:

```yaml
---
title: "AuthService: JWT token generation and refresh"
area: backend
tipo: componente
language: typescript
resumen: "NestJS service implementing JWT login, validateToken, and refresh flow..."
author: "agent/codex"
date: 2026-06-16
source_ref: "auth.service.ts"
tags: ["code/typescript", "modulo/auth", "patron/jwt"]
exports: ["AuthService", "login", "validateToken", "refreshToken"]
depends_on: ["@nestjs/jwt", "@backendkit-labs/result"]
---

## Overview
...
```

---

## Herramientas MCP

### `curate_path`

Analiza un archivo o directorio completo y genera notas en el vault.

```
Parámetros:
  path (string, requerido) — ruta absoluta a un archivo o directorio

Archivos soportados:
  Código:  .ts .tsx .js .jsx .py .go .rs .java .c .cpp .kt .swift
  Docs:    .md .txt .pdf

Comportamiento:
  - Archivo individual: procesa y retorna inmediatamente
  - Directorio: descubre archivos recursivamente, procesa en background (batches de 10)
  - Usa manifest SHA256 para saltear archivos sin cambios en ejecuciones posteriores
  - Ignora: node_modules, dist, build, .git, .venv, __pycache__
```

**Ejemplos desde Claude Code:**

```
Curate el directorio src/ completo
→ curate_path("/project/src")

Curate un archivo específico
→ curate_path("/project/src/auth/auth.service.ts")

Curate documentación PDF
→ curate_path("/project/docs/arquitectura.pdf")
```

---

### `search_vault`

Búsqueda semántica (RAG) contra el vault del proyecto activo.

```
Parámetros:
  query (string, requerido)          — pregunta en lenguaje natural
  topK (number, opcional)            — cuántos resultados retornar (default: 5)
  autoSynthesize (boolean, opcional) — generar nota de síntesis (default: true)

Retorna:
  - results: top-K notas más relevantes con título, contenido y score de relevancia
  - synthesized: nota combinada generada por LLM (si autoSynthesize=true)
  - durationMs: tiempo de búsqueda
```

**Ejemplos:**

```
¿Cómo funciona la autenticación?
→ search_vault("authentication flow JWT")

¿Qué patrones de error handling se usan?
→ search_vault("error handling patterns", topK=3)

Buscar sin síntesis automática
→ search_vault("database connection", autoSynthesize=false)
```

---

### `read_note`

Lee una nota específica del vault por título o ruta relativa.

```
Parámetros:
  path_or_title (string, requerido)
    — título de la nota (búsqueda fuzzy por nombre de archivo)
    — o ruta relativa dentro del vault (ej. "backend/2026-06-16-auth-service.md")
```

**Ejemplos:**

```
Leer por título
→ read_note("AuthService JWT")

Leer por ruta
→ read_note("backend/2026-06-16-auth-service-jwt-token.md")
```

---

### `vault_status`

Muestra el estado del vault y el proyecto activo. Opcionalmente reindexar.

```
Parámetros:
  reload (boolean, opcional) — reindexar el vault (default: false)

Retorna:
  - project: nombre del proyecto
  - projectRoot: directorio raíz del git repo
  - vaultPath: ruta al vault en disco
  - noteCount: cantidad de notas curadas
  - engine: estado del índice RAG
```

**Cuándo usar `reload: true`:** después de que `curate_path` termina el procesamiento en background, llamá `vault_status({ reload: true })` para que las nuevas notas queden disponibles en `search_vault`.

---

## Flujo típico de uso

```
1. Abrir el proyecto en Claude Code
   → el agente detecta el git root automáticamente

2. Primera vez — curar el código base
   → curate_path("/ruta/al/proyecto/src")
   → esperar que el background processing termine (1-60 min según tamaño)

3. Reindexar el vault
   → vault_status({ reload: true })

4. Consultar durante el desarrollo
   → search_vault("¿cómo se valida un token JWT?")
   → read_note("AuthService JWT") para leer la nota completa

5. Curar archivos nuevos o modificados
   → curate_path("/ruta/al/archivo-nuevo.ts")
   → vault_status({ reload: true })
```

---

## Configuración global (todos los proyectos)

Si querés que el agente esté disponible en cualquier proyecto sin configurar cada uno:

```
~/.claude/settings.json   (Linux/Mac)
%APPDATA%\Claude\settings.json   (Windows)
```

```json
{
  "mcpServers": {
    "codex-context": {
      "command": "node",
      "args": ["/ruta/a/codex-context-agent/dist/server.js"],
      "env": {
        "CODEX_API_KEY": "sk-tu-key",
        "CODEX_PROVIDER": "deepseek"
      }
    }
  }
}
```

En este caso el vault se detecta automáticamente por git root cada vez que iniciás Claude Code en un proyecto distinto.

---

## HTTP transport (opcional)

Si necesitás acceder al agente desde herramientas externas además de Claude Code:

```json
{
  "mcpServers": {
    "codex-context": {
      "env": {
        "CODEX_HTTP_PORT": "3200"
      }
    }
  }
}
```

El servidor queda disponible en `POST http://localhost:3200/mcp` con JSON-RPC 2.0.

```bash
curl -X POST http://localhost:3200/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "tools/call",
    "params": {
      "name": "search_vault",
      "arguments": { "query": "authentication" }
    },
    "id": 1
  }'
```
