# MCP Tools — Referencia completa

El agente expone 8 herramientas MCP. Todas retornan JSON serializado en el campo `content[0].text`.

---

## `curate_path`

Analiza un archivo o directorio y extrae conocimiento al vault.

### Parámetros

| Nombre | Tipo | Requerido | Descripción |
|---|---|---|---|
| `path` | string | Sí | Ruta absoluta a un archivo o directorio |

### Archivos soportados

| Tipo | Extensiones |
|---|---|
| Código | `.ts` `.tsx` `.js` `.jsx` `.py` `.go` `.rs` `.java` `.c` `.cpp` `.kt` `.swift` |
| Documentación | `.md` `.txt` `.pdf` |

### Comportamiento por tipo

**Archivo individual:**
- Procesa sincrónicamente
- Retorna inmediatamente con el resultado completo
- `notesWritten`: paths de notas nuevas creadas
- `notesSkipped`: notas que ya existían (dedup por slug+fecha)
- `errors`: errores de LLM o escritura

**Directorio:**
- Descubre archivos recursivamente con `findAllFiles()`
- Ignora: `node_modules`, `dist`, `build`, `.git`, `.venv`, `__pycache__`, directorios ocultos
- Lanza procesamiento en background (batches de 10 en paralelo)
- Retorna inmediatamente con `status: "processing"` y conteo de archivos
- Usa manifest SHA256 para saltear archivos sin cambios

### Respuesta — archivo individual

```json
{
  "notesWritten": ["/home/user/.codex-vaults/my-project/backend/2026-06-16-auth-service-jwt.md"],
  "notesSkipped": [],
  "errors": [],
  "durationMs": 4200,
  "filesAnalyzed": ["src/auth/auth.service.ts"]
}
```

### Respuesta — directorio

```json
{
  "status": "processing",
  "message": "Started curation of 47 files in background",
  "totalFiles": 47,
  "codeFiles": 38,
  "docFiles": 9,
  "vault": "/home/user/.codex-vaults/my-project"
}
```

### Ejemplos de uso desde Claude Code

```
# Curar el src completo del proyecto
"Cura el directorio src/ completo"
→ curate_path("/abs/path/to/project/src")

# Curar un archivo específico
"Curate el servicio de pagos"
→ curate_path("/abs/path/to/project/src/payments/stripe.service.ts")

# Curar documentación PDF
"Curate el documento de arquitectura"
→ curate_path("/abs/path/to/project/docs/arquitectura.pdf")
```

### Notas sobre el LLM y el tiempo

- Archivo de código: ~3-8 segundos (deepseek-reasoner es un modelo de razonamiento lento)
- 47 archivos: ~5-20 minutos en background
- Llamar `vault_status({ reload: true })` después para reindexar

---

## `search_vault`

Búsqueda semántica (RAG) sobre el vault del proyecto activo.

### Parámetros

| Nombre | Tipo | Default | Descripción |
|---|---|---|---|
| `query` | string | — | Pregunta en lenguaje natural |
| `topK` | number | 5 | Cantidad de resultados a retornar |
| `autoSynthesize` | boolean | true | Generar nota de síntesis combinando resultados |

### Respuesta

```json
{
  "query": "cómo funciona la autenticación JWT",
  "results": [
    {
      "title": "AuthService: JWT token generation and refresh",
      "content": "## Overview\nNestJS service que implementa...",
      "relevance": 0.87,
      "sourcePath": "/home/user/.codex-vaults/my-project/backend/2026-06-16-auth-service-jwt.md",
      "sourceRef": "auth.service.ts"
    },
    ...
  ],
  "synthesized": {
    "title": "cómo funciona la autenticación JWT — Synthesis",
    "content": "## Síntesis\nEl sistema de autenticación usa JWT...",
    "basedOn": ["AuthService: JWT token generation", "JwtMiddleware: token validation"]
  },
  "totalResults": 3,
  "durationMs": 1240
}
```

### Cuándo usar autoSynthesize: false

- Cuando solo querés ver qué notas existen sin gastar tokens en síntesis
- En búsquedas muy específicas donde ya sabés qué nota querés
- Cuando el vault es pequeño y los resultados son suficientemente claros

### Ejemplos

```
# Pregunta de arquitectura
search_vault("cómo se estructura la capa de datos")

# Pregunta técnica específica
search_vault("cómo se valida un JWT token expirado", topK=3)

# Búsqueda sin síntesis (más rápida)
search_vault("patrones de error handling", autoSynthesize=false)

# Explorar un módulo
search_vault("todo lo relacionado con pagos y stripe")
```

### Inicialización lazy del índice

La primera vez que se llama `search_vault` en una sesión, el agente indexa el vault completo (genera embeddings). Esto puede tardar 5-15 segundos según el tamaño del vault. Las búsquedas posteriores son instantáneas (el índice queda en memoria).

---

## `read_note`

Lee el contenido completo de una nota del vault.

### Parámetros

| Nombre | Tipo | Requerido | Descripción |
|---|---|---|---|
| `path_or_title` | string | Sí | Título (fuzzy) o path relativo/absoluto al .md |

### Lógica de resolución

1. Si `path_or_title` contiene `/`, `\`, o termina en `.md` → trata como path
   - Absoluto → lee directo
   - Relativo → resuelto desde `vaultPath`
2. Si no → búsqueda fuzzy por nombre de archivo en todo el vault
   - El término se busca en el nombre del archivo (sin importar directorio)
   - Si hay múltiples matches → retorna el más reciente por mtime
   - Si no encuentra → error

### Respuesta

Retorna el contenido completo del archivo `.md`, incluyendo el frontmatter YAML.

```markdown
---
title: "AuthService: JWT token generation and refresh"
area: backend
tipo: componente
language: typescript
resumen: "NestJS service implementing JWT login, validateToken, and refresh..."
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

### Cuándo usar read_note vs search_vault

- `search_vault`: cuando no sabés qué nota buscás, o cuando querés la síntesis
- `read_note`: cuando `search_vault` te dio un título y querés el contenido completo

---

## `vault_status`

Muestra el estado del vault y del proyecto activo. Opcionalmente reindexar.

### Parámetros

| Nombre | Tipo | Default | Descripción |
|---|---|---|---|
| `reload` | boolean | false | Reindexar el vault antes de retornar el estado |

### Respuesta

```json
{
  "project": "my-project",
  "projectRoot": "/home/user/dev/my-project",
  "vaultPath": "/home/user/.codex-vaults/my-project",
  "noteCount": 42,
  "engine": {
    "initialized": true,
    "vaultStats": {
      "indexed": true,
      "vaultPath": "/home/user/.codex-vaults/my-project",
      "indexPath": "/home/user/.codex-context/rag/my-project.json"
    }
  }
}
```

### Cuándo usar reload: true

Después de que `curate_path` termina el procesamiento en background. Las notas nuevas existen en disco pero el índice RAG en memoria no las incluye hasta que se recarga.

Flujo típico:
```
1. curate_path("/project/src")  → "processing 47 files..."
2. ... esperar ~10 minutos ...
3. vault_status({ reload: true }) → reindexar
4. search_vault("...") → ahora incluye las notas nuevas
```

### noteCount

Cuenta todos los `.md` en el vault recursivamente, incluyendo notas de síntesis en `vault/synthesis/`.

---

## `clone_vault`

Copia notas desde un vault existente al vault del proyecto activo. Preserva la estructura de directorios y mergea sin pisar lo que ya existe (por defecto). Reindexea automáticamente al terminar.

### Parámetros

| Nombre | Tipo | Default | Descripción |
|---|---|---|---|
| `sourcePath` | string | — | Ruta absoluta al vault origen (soporta `~` expansion) |
| `overwrite` | boolean | false | Reemplazar notas que ya existen en el target |

### Respuesta

```json
{
  "status": "cloned",
  "sourcePath": "/home/user/.codex-vaults/ia-knowledge",
  "targetVault": "/home/user/.codex-vaults/my-project",
  "copied": 34,
  "skipped": 5,
  "totalNotes": 39,
  "reindexing": true
}
```

---

## `init_embedder`

Descarga e inicializa el modelo de embeddings local (`nomic-embed-text-v1`, ~274MB). Si el modelo ya está en cache, retorna de inmediato. El progreso de descarga se imprime en los logs del servidor (stderr).

### Parámetros

(ninguno)

### Respuesta

```json
{
  "status": "already_cached",
  "model": "Xenova/nomic-embed-text-v1",
  "cacheDir": "/home/user/.cache/codex-context/models",
  "durationMs": 120
}
```

`status` puede ser `"already_cached"`, `"downloaded"`, o `"loaded_from_cache"`.

---

## `reindex_vault`

Reconstruye el índice semántico del vault y bloquea hasta que esté completo. A diferencia del reindexado automático de `curate_path` (que ocurre en background), este espera el resultado.

### Parámetros

(ninguno)

### Respuesta

```json
{
  "status": "indexed",
  "indexed": 42,
  "updated": 7,
  "durationMs": 3800
}
```

---

## `reset_vault`

Borra todas las notas curadas, el índice RAG y los manifests SHA256 del proyecto, y deja el vault vacío listo para reconstruirse desde cero.

### Parámetros

(ninguno)

### Qué borra

| Artefacto | Ruta |
|---|---|
| Notas del vault | `~/.codex-vaults/{proyecto}/` — todas las subcarpetas y archivos `.md` |
| Índice RAG | `~/.codex-context/rag/{proyecto}.json` |
| Manifests SHA256 | Todos los `.codex-manifest.json` bajo la raíz del proyecto |

El vault se recrea vacío y el engine en memoria se resetea.

### Respuesta

```json
{
  "status": "reset",
  "vaultPath": "/home/user/.codex-vaults/my-project",
  "notesDeleted": 42,
  "indexDeleted": true,
  "manifestsDeleted": 3,
  "message": "Vault reset. Run curate_path(\"/home/user/dev/my-project\") to rebuild from scratch."
}
```

### Cuándo usar

- El vault tiene notas desactualizadas y querés empezar de cero
- Cambiaste de versión major del proyecto y las notas ya no son relevantes
- El vault está corrupto (frontmatter inválido, índice inconsistente)
- Cambiaste `CODEX_EMBED_MODEL` y el índice viejo es incompatible con el nuevo modelo
