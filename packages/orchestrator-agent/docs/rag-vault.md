# RAG Vault

The vault is an Obsidian-compatible knowledge base that the orchestrator indexes and searches to provide relevant context to specialist agents. When a subtask runs, the agent receives the top matching vault passages alongside its task — grounding its output in company knowledge without requiring the agent to be aware of the vault.

The vault is also a **write target**: completed runs are automatically distilled by the orchestrator LLM into the vault, and specialist agents inject successful past examples as episodic context. Over time, the vault grows with the organization's own operational knowledge.

## How it works

```
Vault (.md files)          ← human-authored notes
       ↓                   ← auto-consolidated run learnings (v0.2.3+)
[LanceRAGProvider.index()]
  ├── Walk all .md files
  ├── Compare mtime → skip unchanged files
  ├── Chunk by H2+ headings
  ├── Embed each chunk (SimpleEmbedder or OllamaEmbedder)
  └── Store vectors in LanceDB (.orchestrator/rag-lance/)

At task time:
  subtask.task → embed → ANN search → top-5 chunks → injected into agent prompt
  subtask.task → RunStore lookup → top-2 past examples → injected as episodic context
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

## Run consolidation — episodic to semantic (v0.2.3+)

When a run completes successfully, the orchestrator calls an LLM to distill 1–3 reusable learnings from the step outputs. If there's something worth keeping, it's written to the vault as a new note tagged `auto-consolidado`.

```
Run completes
     ↓
consolidateRun(runId, task, steps, llm, vaultWriter)
     ↓
LLM: "Extract reusable learnings. If routine, return NOTHING_TO_CONSOLIDATE."
     ↓
  ┌──────────────┬──────────────────────────────────┐
  │ has learnings│ writes vault/agentes/{date}-*.md │
  │ nothing new  │ skips — no write                 │
  └──────────────┴──────────────────────────────────┘
     ↓
state.vaultNotePath = path to the new note (visible in orchestrator_status)
```

The LLM is the filter. Routine executions that follow pre-existing knowledge produce `NOTHING_TO_CONSOLIDATE` and nothing is written. Only genuinely new knowledge — edge cases discovered, approaches that worked, domain patterns — enters the vault.

**Result:** future runs searching the vault on similar tasks will find this note and receive the distilled knowledge as RAG context, without any human having to write it.

### What gets consolidated

Good consolidation candidates:
- An HR agent discovered that "Engineer" role requires GitHub access + 3 specific Slack channels
- A legal agent found a clause in a contract type that's commonly missed
- An IT agent resolved a permission issue for a class of users in an unusual way

Not consolidated (LLM returns `NOTHING_TO_CONSOLIDATE`):
- Routine onboarding that followed the standard checklist
- Executions that exactly matched existing vault notes
- Tasks where agents just formatted or summarized data

### Viewing consolidated notes

```
orchestrator_status
  config_path: /company/orchestrator.yaml
  run_id: run-1751234567890-abc123

# → ...
# 📝 Guardado en vault: `2026-06-14-aprendizaje-onboard-engineer.md`
```

The note is immediately indexed on the next startup (incremental mtime-based indexing picks it up).

---

## Cross-run episodic injection (v0.2.3+)

Before each specialist agent executes its subtask, the orchestrator queries the `RunStore` for past successful outputs from that same agent on similar tasks. The top 2 matches (by keyword overlap) are injected into the agent prompt as examples.

```
subtask: { agent_id: "hr-agent", task: "Onboard Sofia Ramírez as DevOps Engineer" }
     ↓
RunStore.list() → filter complete runs → filter steps by agentId + success
     ↓
score = matching_keywords / total_query_words  (min threshold: 15%)
     ↓
top-2 examples injected:

  "Examples from past successful runs by this agent:
   Task: Onboard Juan López as Backend Engineer
   Result: Created accounts in GitHub (backend team), Jira, Confluence...

   Task: Onboard María García as Senior Engineer
   Result: Engineer role requires: GitHub org invite, #eng-general, #backend-team..."
```

**Compound effect:** as the team runs more onboardings, the episodic context improves. By run #10, the agent has concrete examples of what worked for similar roles — it doesn't re-discover the same edge cases.

### Availability

Cross-run episodic injection is only active in **inline mode** (no Redis/BullMQ). In distributed mode, workers execute subtasks without direct RunStore access. If you need episodic context in distributed mode, use [run consolidation](#run-consolidation--episodic-to-semantic-v023) — the vault is shared and available to all workers.

---

## Context window considerations

Each search returns up to 5 chunks of ~800 chars each (~4,000 chars of vault context). This is added to the agent's prompt alongside the task and prior steps context. For agents that don't benefit from vault search (e.g., a code formatter), vault context adds noise — consider whether all agents need it.

The vault is searched once per subtask using the task text as the query. There is no recursive or multi-hop retrieval.

Episodic context (past examples) adds ~800 chars per example (2 examples max). Total additional context per agent call in v0.2.3: up to ~1,600 chars episodic + ~4,000 chars vault = ~5,600 chars. This is well within typical context windows but should be considered for very short models.
