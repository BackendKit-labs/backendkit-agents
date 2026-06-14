# Memory System

The orchestrator implements three distinct memory types — each with a different storage backend, retention policy, and role in the agent's reasoning. Together they form a learning loop where every run makes future runs smarter.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        orchestrator-agent                        │
│                                                                  │
│  ┌──────────────┐    consolidateRun()    ┌──────────────────┐   │
│  │  Episodic    │ ─────────────────────► │    Semantic      │   │
│  │  (RunStore)  │                        │  (LanceDB vault) │   │
│  └──────────────┘                        └──────────────────┘   │
│         │                                        │               │
│         │ buildEpisodicFn()                      │ ragSearchFn() │
│         │                                        │               │
│         └──────────────┬─────────────────────────┘               │
│                        ▼                                         │
│              specialist agent prompt                             │
│         [task] + [vault context] + [past examples]              │
│                        │                                         │
│                        ▼                                         │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │              Procedural (manifest.yaml)                   │   │
│  │  Cable 2: deterministic rules enforced before each step  │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

---

## Episodic memory — RunStore

**What:** history of every workflow execution — what ran, when, what each agent produced, what gates fired.

**Storage:** JSON files in `.orchestrator/runs/` (disk) or Redis sorted set (distributed mode).

**Key fields in each run:**
```typescript
RunState = {
  runId, task, status,
  startedAt, completedAt,
  completedSteps: StepResult[],   // ← the episodic record
  waitingGate?, finalReport?,
  vaultNotePath?,                 // ← set after consolidation
}

StepResult = {
  stepId, agentId, task,
  output,    // ← what the agent produced
  success,
  durationMs,
}
```

**Used for:**
- Cross-run episodic injection (see below)
- Reflection system (Cable 1: gate outcome recording)
- Run status queries via `orchestrator_status` and `orchestrator_list_runs`
- Consolidation source: step outputs feed `consolidateRun()`

**Pruning:** `RunStore.prune(maxAgeDays = 30)` removes terminal runs older than N days. Called automatically on server startup.

---

## Semantic memory — LanceDB vault

**What:** chunked, embedded knowledge base of markdown notes. Both human-authored and auto-consolidated by the orchestrator.

**Storage:** LanceDB Apache Arrow format in `.orchestrator/rag-lance/`.

**Indexing:** incremental on startup — only files with changed `mtime` are re-embedded.

**Search:** ANN cosine distance, top-5 chunks per query. Threshold: similarity ≥ 0.1 (cosine distance ≤ 0.9).

**Write sources:**

| Source | Tag | Trigger |
|--------|-----|---------|
| Human-authored notes | any | Manual edit in Obsidian or any editor |
| Specialist agents | via `write_knowledge` tool | Agent explicitly writes during task |
| Run consolidation | `auto-consolidado` | Automatic after each successful run |

**Used for:**
- Vault context injected into every agent prompt before execution
- Planner context in dynamic plan generation (`planDynamic`)
- Reflection system for domain knowledge queries

---

## Procedural memory — manifest.yaml

**What:** deterministic rules derived from recurring gate failure patterns. Enforced before any matching step runs — no LLM involved.

**Storage:** `manifest.yaml` in the vault directory (auto-managed by `EnterpriseReflection`).

**Structure:**
```yaml
policyRules:
  - id: rule-001
    name: "HR data must be validated before onboarding"
    trigger:
      domain: rrhh
      pattern: data-validation
      minOccurrences: 3
    if:
      domain: rrhh
      keywords: [onboarding, datos, empleado]
    then:
      mustInclude:
        - "checklist de documentación completo"
        - "datos del empleado verificados"
```

**Lifecycle:** pattern detected (Cable 1) → pending promotion → human approves via `orchestrator_reflect_promote` → rule added to `manifest.yaml` → Cable 2 enforces on all future matching steps.

See [Enterprise reflection](reflection.md) for the full MAPE-K cycle.

---

## The learning loop

```
Run executes
     │
     ▼
[Cable 1] Gate outcomes recorded per rule ID
     │
     ▼
completedSteps saved to RunStore (episodic)
     │
     ├──► consolidateRun()
     │         └── LLM distills learnings → vault note (semantic)
     │
     ├──► buildEpisodicFn()
     │         └── next run: top-2 past examples injected into agent prompt
     │
     └──► reflection.pendingPromotions()
               └── human approves → manifest.yaml rule (procedural)
```

**Run N feeds Run N+1 through three paths:**
1. **Semantic**: vault grows with distilled knowledge → better RAG context
2. **Episodic**: RunStore holds past outputs → better examples for specialist agents
3. **Procedural**: gate patterns → deterministic rules → fewer surprises

---

## Run consolidation in detail

`consolidateRun()` is called at the end of every successful run when a vault is configured.

```typescript
// src/consolidate.ts
consolidateRun(runId, task, steps, callLLMFn, vaultWriter)
```

**Algorithm:**
1. Filter `steps` to successful ones only
2. Format as `[agentId] Task: ... \nOutput: ...` (max 600 chars per step)
3. LLM call with prompt: "Extract 1-3 reusable learnings. If routine, return NOTHING_TO_CONSOLIDATE."
4. If response ≠ `NOTHING_TO_CONSOLIDATE`: write note to `vault/agentes/{date}-aprendizaje-*.md`
5. Return vault note path → stored in `RunState.vaultNotePath`

**LLM filter behavior:**

The consolidation LLM acts as a quality gate. It returns `NOTHING_TO_CONSOLIDATE` when:
- The run executed standard steps that match existing vault notes
- There were no notable discoveries or edge cases
- The output is a pure data transformation (formatting, summarizing) with no decision-making

It writes when:
- An agent discovered a domain-specific requirement not in the vault
- A task revealed an exception to a standard process
- An agent resolved a non-obvious issue through a specific approach

**Note tags:** `área/orquestador`, `función/aprendizaje`, `auto-consolidado`

---

## Cross-run episodic injection in detail

`buildEpisodicFn(store)` creates a lookup function that `PlanExecutor` calls before each inline subtask execution.

```typescript
// In server.ts
const episodicFn = buildEpisodicFn(store);
// Passed to PlanExecutor → executeSubtask()
```

**Algorithm:**
1. Load all runs from `RunStore` (cached per request via `store.list()`)
2. Filter: `status === 'complete'` AND `agentId === subtask.agent_id` AND `success === true` AND `output.length > 50`
3. Score each past step: `matching_query_tokens / total_query_tokens` (keyword overlap, threshold 15%)
4. Return top-2 by score, formatted as:

```
Examples from past successful runs by this agent:
Task: <past task>
Result: <first 400 chars of past output>

Task: <past task>
Result: <first 400 chars of past output>
```

5. This block is injected into the user prompt between vault context and prior step context.

**Performance notes:**
- `store.list()` reads all runs from disk on each call in disk mode — acceptable for ≤ 500 runs
- In Redis mode, `zrevrange` is O(log N + M) where M = returned elements
- Cross-run injection is **disabled in BullMQ mode**: workers don't have shared RunStore access. Vault consolidation (semantic memory) covers the distributed case.

---

## Forgetting curve (agent-core EpisodicMemory)

The `EpisodicMemory` class in `@backendkit-labs/agent-core` now prunes by **relevance score** instead of raw age when `maxEpisodes` is set.

### Relevance formula

```
relevanceScore(episode) =
  recency(0.6) × 1 / (1 + daysSince × 0.1)
  + utility(0.4) × log(1 + recallCount)
```

Where:
- `daysSince` = days since `createdAt`
- `recallCount` = how many times this episode was returned by `recall()`

**Behavior examples** (maxEpisodes = 100, slot is full):

| Episode | Age | Recalls | Score |
|---------|-----|---------|-------|
| New, never recalled | 0 days | 0 | 0.60 |
| 10 days old, never recalled | 10 days | 0 | 0.30 |
| 30 days old, recalled 4× | 30 days | 4 | 0.15 + 0.28 = **0.43** |
| 30 days old, never recalled | 30 days | 0 | **0.15** |

The 30-day-old episode recalled 4 times (0.43) survives the prune cycle over a never-recalled episode of the same age (0.15). An episode that's useful keeps itself alive.

### Recall tracking

Every `recall()` call increments `recallCount` on matched episodes via `upsert()`. This is stored in the backend (persisted in `JsonFileStore`, in-memory otherwise).

```typescript
// After recall() returns 3 episodes:
// → episode A: recallCount 0 → 1
// → episode B: recallCount 2 → 3
// → episode C: recallCount 0 → 1
```

### Usage (no config change required)

The forgetting curve is active automatically whenever `maxEpisodes` is set:

```typescript
const memory = createMemorySystem({
  episodic: { provider: 'json', path: './episodes.json' },
  retention: {
    maxEpisodes: 200,   // ← forgetting curve kicks in when this limit is hit
  },
});
```

When the store reaches 201 episodes, the one with the lowest `relevanceScore` is deleted — not necessarily the oldest.

---

## Data directory layout

```
.orchestrator/
  runs/                    ← episodic: one JSON file per run
    run-1234-abc.json
    run-5678-def.json
  rag-lance/               ← semantic: LanceDB Arrow format
    chunks.lance/
      data/                ← embedded chunks (vector + text + mtime)
      _indices/            ← ANN index

vault/                     ← semantic source
  agentes/
    2026-06-14-aprendizaje-onboard-engineer.md   ← auto-consolidated
  decisiones/
  guias/
  politicas/
    manifest.yaml          ← procedural: active policy rules
```
