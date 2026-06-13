# Paso 2: RAG Integration & Knowledge Search

Unified **curation + semantic search** in curator-codex-agent.

## 🎯 What's New

```
curator-codex-agent v0.2.0

Curation (Paso 1) ✅
├── curator_process_file          → Analyze single file
├── curator_process_directory     → Analyze entire directory
└── curator_vault_status          → Vault info

Search & Synthesis (Paso 2) ✅ NEW
├── knowledge_search              → Semantic search + auto-synthesis
├── knowledge_reload              → Reindex vault
└── knowledge_stats               → Knowledge engine stats
```

## 📡 New MCP Tools

### `knowledge_search`

Semantic search the vault using RAG (Retrieval-Augmented Generation).

**Parameters:**
- `query` (required): Natural language search query
- `topK` (optional): Number of results (default: 5)
- `autoSynthesize` (optional): Generate synthesis note (default: true)

**Example:**

```bash
# Via MCP (Claude Desktop or bk-agent)
tools.knowledge_search({
  query: "How to handle authentication errors?",
  topK: 5,
  autoSynthesize: true
})
```

**Response:**

```json
{
  "query": "How to handle authentication errors?",
  "results": [
    {
      "title": "AuthService: JWT-based Authentication",
      "content": "...",
      "relevance": 0.95,
      "sourcePath": "/vault/general/2026-06-13-authservice-api.md"
    },
    {
      "title": "Error Handling Best Practices",
      "content": "...",
      "relevance": 0.87,
      "sourcePath": "/vault/general/2026-06-13-error-handling-guide.md"
    }
  ],
  "synthesized": {
    "title": "How to handle authentication errors? — Synthesis",
    "content": "## Overview\n...",
    "basedOn": ["AuthService: JWT-based Authentication", "Error Handling Best Practices"]
  },
  "totalResults": 2,
  "durationMs": 1420
}
```

### `knowledge_reload`

Reload and reindex the vault after external changes.

**Example:**

```bash
tools.knowledge_reload({})
```

**Response:**

```json
{
  "indexed": 150,
  "updated": 45,
  "durationMs": 8920
}
```

### `knowledge_stats`

Get knowledge engine statistics.

**Example:**

```bash
tools.knowledge_stats({})
```

**Response:**

```json
{
  "initialized": true,
  "vaultStats": {
    "indexed": true,
    "vaultPath": "/path/to/vault",
    "indexPath": "/home/user/.curator-codex/rag/vault.json"
  }
}
```

## 🔄 Workflows

### Workflow 1: Search + Auto-Synthesis

```
User Query: "¿Cómo manejar errores de autenticación?"
    ↓
knowledge_search(query, autoSynthesize=true)
    ↓
1. RAG search finds relevant notes (0.95, 0.87, 0.78 relevance)
2. KnowledgeSynthesizer generates synthetic note:
   - Combines insights from 3 documents
   - Adds practical examples
   - Creates new markdown file
3. Returns search results + preview of synthesis
    ↓
User reads:
  - Top 5 relevant notes from vault
  - Synthesis that answers the specific query
  - All in one response
```

### Workflow 2: Curator + Search Combined

```
User/Agent wants to:
1. Curate new code + docs
2. Search the resulting vault

bk-agent:
  1. curator_process_directory("/my-project")
     → 150 notes written to vault
  
  2. knowledge_reload()
     → Reindex vault (150 + existing)
  
  3. knowledge_search("¿Arquitectura del proyecto?")
     → RAG search returns relevant notes
     → Synthesis creates unified overview

Result: Vault curated + searchable in one flow
```

### Workflow 3: Multi-Domain Knowledge

```
Day 1: Curate backend code
  curator_process_directory("/backend")
  → 100 notes
  knowledge_reload()

Day 8: Add compliance docs
  curator_process_directory("/compliance")
  → 50 more notes
  knowledge_reload()

Day 15: Search across domains
  knowledge_search("GDPR-compliant caching")
  ↓
  Finds:
  - Caching notes (from backend)
  - GDPR notes (from compliance)
  - Synthesis connecting both
  
Result: Cross-domain knowledge discovery
```

## 🧠 Synthesis Magic

When you search, knowledge-agent **automatically generates** synthetic notes:

```
Synthesis Process:

1. Find relevant documents via RAG
   Search: "How to implement authentication?"
   Results: [AuthService.md, JWT-patterns.md, Security.md]

2. Extract key insights
   - From AuthService: APIs, usage examples
   - From JWT-patterns: Best practices, pitfalls
   - From Security: Security considerations

3. Generate synthetic note
   System: "Synthesize these into a guide"
   LLM generates: "Complete Authentication Implementation Guide"
   
   Note combines:
   ✓ Code examples (from AuthService)
   ✓ Best practices (from JWT-patterns)
   ✓ Security (from Security)
   ✓ Practical step-by-step instructions (LLM)

4. Save to vault
   File: 2026-06-13-complete-authentication-implementation-guide-v1.md
   Metadata:
     - based_on: [AuthService.md, JWT-patterns.md, Security.md]
     - synthesis_version: 1
     - generated_by: knowledge-agent
```

**Next search for "authentication":**
- Finds: AuthService.md, JWT-patterns.md, Security.md
- PLUS: Complete Authentication Implementation Guide (synthesis)
- Better results, more complete answers

## 📊 Architecture

```
Curator-Codex-Agent v0.2.0

┌────────────────────────────────────────┐
│         MCP Server (Stdio + HTTP)      │
├────────────────────────────────────────┤
│ Curation Tools                         │
│ ├── curator_process_file               │
│ ├── curator_process_directory          │
│ └── curator_vault_status               │
│                                         │
│ Knowledge Tools (NEW)                  │
│ ├── knowledge_search                   │
│ ├── knowledge_reload                   │
│ └── knowledge_stats                    │
└────────────────────────────────────────┘
           ↓
┌────────────────────────────────────────┐
│       Knowledge Engine                 │
├────────────────────────────────────────┤
│ ├── CuratorRagProvider                 │
│ │   └── ObsidianRAGProvider            │
│ │       └── Semantic embeddings        │
│ │                                       │
│ ├── KnowledgeSynthesizer               │
│ │   └── LLM-based synthesis            │
│ │                                       │
│ └── Indexing & Caching                 │
│     └── .curator-codex/rag/vault.json  │
└────────────────────────────────────────┘
           ↓
┌────────────────────────────────────────┐
│         Vault Storage                  │
├────────────────────────────────────────┤
│ ├── general/                           │
│ │   ├── base-notes/ (from curation)    │
│ │   └── synthesis/ (from search)       │
│ ├── backend/                           │
│ ├── compliance/                        │
│ └── ...                                │
└────────────────────────────────────────┘
```

## 🚀 Usage Examples

### Example 1: Claude Desktop + RAG

```bash
# Start server with HTTP (for external tools)
CURATOR_HTTP_PORT=3101 npm start
```

Register in Claude Desktop config:
```json
{
  "mcpServers": {
    "curator-codex": {
      "command": "npx",
      "args": ["-y", "@backendkit-labs/curator-codex-agent"],
      "env": {
        "CURATOR_API_KEY": "sk-...",
        "CURATOR_OUTPUT_PATH": "/vault"
      }
    }
  }
}
```

In Claude:
```
Me: "Analyze my project and tell me how authentication works"

Claude uses:
1. curator_process_directory("/my-project")
   → Vault: 150 notes

2. knowledge_reload()
   → Index: 150 chunks

3. knowledge_search("authentication architecture")
   → Results: [AuthService, JWT guide, Security]
   → Synthesis: "Complete Auth Guide"

4. Reads synthesis + base notes
   → Explains: "Your project uses JWT-based auth with..."
```

### Example 2: bk-agent with Embedded Curator

```typescript
// bk-agent internally
const curator = spawn('npm', ['start'], {
  env: {
    CURATOR_OUTPUT_PATH: '/vault',
    CURATOR_API_KEY: 'sk-...'
  }
});

// Use tools:
await agent.tools.curator_process_directory({
  directory_path: '/my/project'
});

await agent.tools.knowledge_reload({});

const results = await agent.tools.knowledge_search({
  query: 'How does the authentication flow work?'
});

agent.respond(`Based on your codebase:
${results.synthesized.content}

Sources: ${results.results.map(r => r.title).join(', ')}`);
```

### Example 3: Incremental Multi-Domain Curation

```bash
# Day 1: Curate backend
curl -X POST http://localhost:3100/curator/process \
  -H "Content-Type: application/json" \
  -d '{"inputPath":"/backend","outputPath":"/vault"}'
# Response: 100 notes written

# Day 8: Add compliance
curl -X POST http://localhost:3100/curator/process \
  -H "Content-Type: application/json" \
  -d '{"inputPath":"/compliance","outputPath":"/vault"}'
# Response: 50 notes written

# Reload index
curl -X POST http://localhost:3100/knowledge/reload
# Response: 150 indexed, 50 updated

# Search across domains
curl -X POST http://localhost:3100/knowledge/search \
  -H "Content-Type: application/json" \
  -d '{"query":"How to implement GDPR-compliant caching?"}'
# Returns: caching + GDPR notes + synthesis combining both
```

## 🎯 What Happens Behind the Scenes

### Indexing (knowledge_reload)

```
Vault Files:
├── authservice-api.md
├── jwt-patterns.md
├── gdpr-compliance.md
└── ...

↓ Indexing Process:

1. Read all .md files
2. Split into chunks (~300 tokens each)
3. Generate embeddings (using SimpleEmbedder)
4. Store in vector index (~vault.json)
5. Enable semantic search

Time: ~8-10 seconds per 100 files
Result: ~/.curator-codex/rag/vault.json (15-20 MB for 150 files)
```

### Search (knowledge_search)

```
Query: "How to handle auth errors?"

↓ Search Process:

1. Embed query (0.2 seconds)
2. Find semantically similar chunks (cosine similarity)
3. Return top-5 by relevance score
4. If autoSynthesize=true:
   - Send results to LLM
   - Generate synthesis note
   - Save to vault/synthesis/
5. Return results + synthesis

Time: ~1-2 seconds
```

## 📋 Performance Notes

| Operation | Time | Notes |
|-----------|------|-------|
| Index 100 files | 8-10s | One-time, can reuse |
| Search 1 query | 1-2s | Fast, semantic |
| Generate synthesis | 2-3s | LLM call |
| Reload vault | 8-10s | Picks up new files |

## 🔍 Troubleshooting

### Search returns no results
```
Cause: Vault not indexed
Fix: Call knowledge_reload() first
```

### Synthesis not generated
```
Cause: autoSynthesize=false or LLM error
Fix: Check logs, ensure API key is valid
```

### Slow searches
```
Cause: Large vault (500+ files)
Fix: Normal, search is still fast (<2s)
```

## 🎉 You Now Have

✅ **Curation** — analyze code + docs  
✅ **Semantic Search** — RAG across vault  
✅ **Synthesis** — auto-generate summary notes  
✅ **Flexibility** — stdio + HTTP transports  
✅ **Scalability** — works with 100-1000 files  

## 🚀 Next Steps (Paso 3)

- Authentication / security for HTTP endpoints
- Advanced synthesis (multi-language support)
- Webhook integration for CI/CD
- Dashboard for vault management

---

**Start using it:**

```bash
npm start
# or with HTTP:
CURATOR_HTTP_PORT=3101 npm start
```

Then use `knowledge_search()` and `curator_process_directory()` tools!
