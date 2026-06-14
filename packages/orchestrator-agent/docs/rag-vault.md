# RAG Vault

The vault is an Obsidian-compatible knowledge base that the orchestrator indexes and searches to provide relevant context to specialist agents. When a subtask runs, the agent receives the top matching vault passages alongside its task — grounding its output in company knowledge without requiring the agent to be aware of the vault.

## How it works

```
Vault (.md files)
       ↓
[LanceRAGProvider.index()]
  ├── Walk all .md files
  ├── Compare mtime → skip unchanged files
  ├── Chunk by H2+ headings
  ├── Embed each chunk (SimpleEmbedder or OllamaEmbedder)
  └── Store vectors in LanceDB (.orchestrator/rag-lance/)

At task time:
  subtask.task → embed → ANN search → top-5 chunks → injected into agent prompt
```

## Configuration

```yaml
orchestrator:
  vault:
    path: /shared/company-vault     # path to your vault directory
    embedder: simple                # "simple" (no deps) | "ollama" (better quality)
    ollama_host: http://localhost:11434   # only used when embedder = ollama
    ollama_model: nomic-embed-text       # only used when embedder = ollama
```

## Embedder options

| Embedder | Quality | Dependencies | Use when |
|----------|---------|--------------|----------|
| `simple` | Good for exact/keyword matches | None | Pilot, no GPU, no Ollama |
| `ollama` | Semantic similarity | Ollama running locally | Production, semantic search needed |

### `simple` (default)

Uses a TF-IDF-style hash trick. Fixed-dimension vectors, no external services required. Works well for vaults where exact terminology matters.

### `ollama`

Uses `nomic-embed-text` (or any other model) via Ollama's `/api/embeddings` endpoint. 768-dimensional dense vectors with proper semantic understanding — "employee" and "staff member" will match.

**Setup:**
```bash
ollama pull nomic-embed-text
ollama serve   # typically already running
```

```yaml
vault:
  path: /shared/vault
  embedder: ollama
  ollama_host: http://localhost:11434
  ollama_model: nomic-embed-text
```

## LanceDB index

The vector index lives at `.orchestrator/rag-lance/` (inside the data directory). It persists across server restarts.

```
.orchestrator/
  rag-lance/
    chunks.lance/          ← LanceDB table directory
      data/                ← Arrow files (the actual vectors + text)
      _indices/            ← ANN index (if created)
```

### Incremental indexing

On each startup, the indexer:
1. Reads all `.md` files from the vault
2. Compares each file's `mtime` against the stored value
3. Only re-embeds files that changed or are new
4. Deletes chunks for files that were removed from the vault

For a vault of 1,000 notes, a typical startup re-indexes 2-5 changed files in under a second.

### Chunking strategy

Each document is split into semantic chunks:
1. **H2+ headings**: split on `##`, `###`, etc. — each section becomes a chunk
2. **Paragraph fallback**: sections > 800 chars are further split at paragraph breaks
3. **Fixed window**: files without headings are split into 800-char windows

Minimum chunk size: 40 chars (filters out empty sections and YAML frontmatter noise).

### Search

Query text is embedded and searched via ANN (approximate nearest neighbor) in LanceDB using cosine distance. The top-5 most similar chunks are returned and injected into the agent's prompt as:

```
Relevant knowledge:
[filename1.md]
<chunk content>

---

[filename2.md]
<chunk content>
```

Chunks with cosine distance > 0.9 (similarity < 0.1) are filtered out as irrelevant noise.

## Vault structure tips

The vault can be any directory of `.md` files. Obsidian vaults work out of the box. Organize content so that each note covers a focused topic — the chunker respects H2+ headings, so well-structured notes with clear sections produce better retrieval.

**Recommended structure:**
```
vault/
  agentes/           ← agent capabilities and responsibilities
  decisiones/        ← architecture and business decisions
  guias/             ← how-to guides and processes
  patrones/          ← design patterns used in the company
  politicas/         ← HR, legal, and operational policies
  lecciones/         ← lessons learned and common pitfalls
```

Hidden directories (starting with `.`) and the `.obsidian/` folder are automatically skipped.

## Re-indexing from scratch

To force a full re-index (e.g., after switching embedders):

```bash
rm -rf .orchestrator/rag-lance/
# Restart the orchestrator — it will re-index on next startup
```

The old JSON index (`.orchestrator/rag/vault.json`) from before v0.2.1 can also be deleted:
```bash
rm -rf .orchestrator/rag/
```

## Context window considerations

Each search returns up to 5 chunks of ~800 chars each (~4,000 chars of vault context). This is added to the agent's prompt alongside the task and prior steps context. For agents that don't benefit from vault search (e.g., a code formatter), vault context adds noise — consider whether all agents need it.

The vault is searched once per subtask using the task text as the query. There is no recursive or multi-hop retrieval.
