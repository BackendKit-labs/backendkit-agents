# RAG Search — Búsqueda semántica

## Qué es RAG en este contexto

RAG (Retrieval-Augmented Generation) significa que en lugar de pedirle al LLM que recuerde el código de tu proyecto (imposible), le damos los fragmentos más relevantes del vault como contexto. El flujo es:

```
Query del agente
    → Embedding del query (vector numérico)
    → Comparar con embeddings de todas las notas del vault
    → Recuperar top-K notas más similares
    → (opcional) LLM sintetiza esas notas en una respuesta
    → Retornar al agente
```

## Componentes

### SimpleEmbedder

Convierte texto en vectores numéricos. Implementado en `@backendkit-labs/agent-enterprise`. Es un embedder liviano (no requiere llamada a API externa) — usa representaciones de frecuencia de términos con algunas heurísticas semánticas.

**Características:**
- Sin latencia de red (todo local)
- Sin costo de tokens
- Suficientemente preciso para búsqueda de código y documentación técnica
- No requiere modelo de embeddings externo (OpenAI ada, etc.)

### ObsidianRAGProvider

Capa de indexado y búsqueda implementada en `@backendkit-labs/agent-enterprise`. Diseñada originalmente para vaults Obsidian, funciona con cualquier directorio de archivos `.md`.

**Responsabilidades:**
- Leer todos los `.md` del vault
- Dividirlos en chunks
- Generar embeddings por chunk
- Persistir el índice en `~/.codex-context/rag/{vault}.json`
- Búsqueda por cosine similarity

### CuratorRagProvider

Wrapper local sobre `ObsidianRAGProvider` que:
- Maneja el ciclo de vida del índice (inicializado, indexado, reload)
- Mapea el resultado al tipo `RagSearchResult` del agente
- Guarda el índice en `~/.codex-context/rag/` (no en `~/.curator-codex/`)
- Incluye guarda defensiva: si `rag.search()` retorna algo que no es array → retorna `[]`

### KnowledgeEngine

Orquesta `CuratorRagProvider` + `KnowledgeSynthesizer`. Es el que recibe la llamada desde el tool `search_vault` y coordina:

1. Inicialización lazy del índice
2. Búsqueda RAG
3. Síntesis opcional

## Índice RAG

### Ubicación

```
~/.codex-context/rag/{nombre-del-vault}.json
```

Es un archivo JSON con la estructura de chunks y embeddings. Se genera una sola vez y se reutiliza en sesiones posteriores.

### Cuándo se genera

- Primera llamada a `search_vault` en una sesión (lazy init)
- `vault_status({ reload: true })` — fuerza regeneración

### Cuándo se actualiza

Solo cuando se llama `reload`. Las notas nuevas curadas con `curate_path` NO actualizan el índice automáticamente — hay que hacer un reload explícito.

### Tamaño aproximado del índice

- 50 notas → ~200KB
- 200 notas → ~800KB
- 500 notas → ~2MB

## Búsqueda — detalle técnico

### Cosine similarity

La similitud entre el query y cada chunk se calcula como:

```
similarity = dot(embed(query), embed(chunk)) / (|embed(query)| × |embed(chunk)|)
```

Rango: 0 (sin relación) a 1 (idénticos).

### minScore

Por defecto `0.1`. Chunks con similarity < 0.1 se filtran antes de retornar. Esto elimina resultados completamente irrelevantes.

### topK

Por defecto `5`. El agente retorna los K chunks con mayor similarity. Podés bajar a `3` para búsquedas más precisas o subir a `10` para exploración más amplia.

## Síntesis automática

Cuando `autoSynthesize: true` (default), después de la búsqueda RAG el agente:

1. Toma los top-K resultados
2. Construye un prompt con los primeros 1000 caracteres de cada resultado
3. Llama al LLM con el prompt: "Genera una nota markdown que sintetice estos documentos en respuesta a la query"
4. Guarda la nota de síntesis en `vault/synthesis/{date}-{query-slug}-v1.md`
5. Retorna `synthesized.content` (preview de 500 chars) junto con los resultados raw

### Costo de la síntesis

- 1 llamada LLM adicional por búsqueda
- ~1-3 segundos extra
- La nota de síntesis queda guardada — si hacés la misma búsqueda mañana, la nota ya existe en el vault (aunque el índice no la incluye automáticamente)

## Tips para mejores búsquedas

### Usar términos del código, no descripciones

```
# Menos efectivo
search_vault("el sistema que maneja usuarios")

# Más efectivo
search_vault("UserService createUser repository pattern")
```

### Buscar por patrones y conceptos

```
search_vault("error handling Result type pattern")
search_vault("dependency injection NestJS providers")
search_vault("database connection pooling configuration")
```

### Combinar con read_note

```
1. search_vault("autenticación") → retorna títulos de 5 notas relevantes
2. read_note("AuthService JWT") → lee la nota completa con todos los detalles
```

### Reload después de curar

```
curate_path("/project/src/new-feature/")
vault_status({ reload: true })   ← sin esto, las notas nuevas no aparecen en búsquedas
search_vault("new feature implementation")
```
