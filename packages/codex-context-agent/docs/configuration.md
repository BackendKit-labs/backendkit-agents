# Configuración

## Variables de entorno

### Requeridas

| Variable | Descripción |
|---|---|
| `CODEX_API_KEY` | API key del proveedor LLM. Requerida salvo Ollama (que no necesita key real). |

### Opcionales — Proyecto

| Variable | Default | Descripción |
|---|---|---|
| `CODEX_PROJECT_PATH` | `process.cwd()` | Raíz del proyecto. Si se omite, se usa el CWD al momento de arrancar el servidor. El agente ejecuta `git rev-parse --show-toplevel` desde este path para encontrar el git root. |

### Opcionales — Proveedor LLM

| Variable | Default | Descripción |
|---|---|---|
| `CODEX_PROVIDER` | `deepseek` | Proveedor: `deepseek`, `openai`, `anthropic`, `ollama` |
| `CODEX_MODEL` | Default del proveedor | Modelo específico (ver tabla de proveedores) |
| `CODEX_BASE_URL` | Default del proveedor | Endpoint personalizado. Útil para proxies o compatibles OpenAI. |

### Opcionales — Transporte

| Variable | Default | Descripción |
|---|---|---|
| `CODEX_HTTP_PORT` | Sin HTTP | Puerto para activar el transporte HTTP además del stdio. Ej: `3200` |

---

## Proveedores LLM

### DeepSeek (recomendado)

```json
{
  "CODEX_PROVIDER": "deepseek",
  "CODEX_API_KEY": "sk-...",
  "CODEX_MODEL": "deepseek-reasoner"
}
```

- `deepseek-reasoner`: modelo de razonamiento, mejor calidad de análisis, ~4-8s por archivo
- `deepseek-chat`: más rápido, menor costo, ~1-3s por archivo
- Base URL: `https://api.deepseek.com/v1`

### OpenAI

```json
{
  "CODEX_PROVIDER": "openai",
  "CODEX_API_KEY": "sk-...",
  "CODEX_MODEL": "o3-mini"
}
```

- Compatible con cualquier endpoint OpenAI-compatible (Azure, Together, etc.)
- Para Azure: `CODEX_BASE_URL=https://{resource}.openai.azure.com/openai/deployments/{deployment}`

### Anthropic (Claude)

```json
{
  "CODEX_PROVIDER": "anthropic",
  "CODEX_API_KEY": "sk-ant-...",
  "CODEX_MODEL": "claude-sonnet-4-6"
}
```

- Default model: `claude-sonnet-4-6`
- No usa `CODEX_BASE_URL` (Anthropic SDK maneja el endpoint internamente)

### Ollama (local, sin costo)

```json
{
  "CODEX_PROVIDER": "ollama",
  "CODEX_API_KEY": "ollama",
  "CODEX_MODEL": "qwen2.5-coder:7b"
}
```

- Requiere Ollama corriendo en `http://localhost:11434`
- `CODEX_API_KEY` puede ser cualquier string (no se valida)
- Modelos recomendados para análisis de código: `qwen2.5-coder:7b`, `codellama:13b`, `deepseek-coder-v2:16b`
- Para endpoint custom: `CODEX_BASE_URL=http://localhost:11434/v1`

---

## Configuración en Claude Code

### Archivos de settings

Claude Code lee y fusiona dos archivos:

| Archivo | Committed | Propósito |
|---|---|---|
| `.claude/settings.json` | Sí | Configuración del equipo: path al servidor, project path |
| `.claude/settings.local.json` | No (gitignored) | Configuración local: API key, overrides personales |

Las claves de `env` en ambos archivos se fusionan. Si la misma clave aparece en los dos, `settings.local.json` tiene prioridad.

### settings.json — estructura completa

```json
{
  "mcpServers": {
    "codex-context": {
      "command": "node",
      "args": [
        "/ruta/absoluta/packages/codex-context-agent/dist/server.js"
      ],
      "env": {
        "CODEX_PROJECT_PATH": "/ruta/absoluta/al/proyecto"
      }
    }
  }
}
```

### settings.local.json — estructura completa

```json
{
  "mcpServers": {
    "codex-context": {
      "env": {
        "CODEX_API_KEY": "sk-tu-key-real",
        "CODEX_PROVIDER": "deepseek",
        "CODEX_MODEL": "deepseek-chat"
      }
    }
  }
}
```

### Configuración global (todos los proyectos)

Para no configurar cada proyecto individualmente, podés agregar el MCP server en el settings global de Claude Code:

- **Windows**: `%APPDATA%\Claude\settings.json`
- **macOS/Linux**: `~/.claude/settings.json`

```json
{
  "mcpServers": {
    "codex-context": {
      "command": "node",
      "args": ["/ruta/global/codex-context-agent/dist/server.js"],
      "env": {
        "CODEX_API_KEY": "sk-tu-key",
        "CODEX_PROVIDER": "deepseek"
      }
    }
  }
}
```

Sin `CODEX_PROJECT_PATH`, el agente detecta el proyecto desde el CWD en que Claude Code lo lanza. Cambiando de proyecto se cambia el vault automáticamente.

---

## Configuración del transporte HTTP

Para acceder al agente desde herramientas externas además de Claude Code:

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

O al correr manualmente:

```bash
CODEX_API_KEY=sk-... CODEX_HTTP_PORT=3200 node dist/server.js
```

El endpoint HTTP acepta JSON-RPC 2.0 en `POST /mcp`. El transporte stdio sigue activo simultáneamente.

---

## Paths del vault e índice

| Path | Descripción |
|---|---|
| `~/.codex-vaults/{proyecto}/` | Vault principal — notas curadas |
| `~/.codex-context/rag/{proyecto}.json` | Índice RAG — embeddings y chunks |
| `{input-dir}/.codex-manifest.json` | Manifest SHA256 por directorio curado |

Todos los paths se crean automáticamente. Si necesitás resetear el índice RAG, borrá `~/.codex-context/rag/{proyecto}.json` y llamá `vault_status({ reload: true })`.
