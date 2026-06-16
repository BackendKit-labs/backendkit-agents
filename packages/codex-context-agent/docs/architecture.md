# Arquitectura

## Módulos

```
src/
├── server.ts              # Entry point. Registra tools MCP, levanta transportes.
├── project.ts             # Detección de git root y resolución del vault path.
├── analyzer.ts            # CodeAnalyzer — dispatcher de archivos + análisis de código.
├── documentation-curator.ts  # DocumentationCurator — análisis de .md, .txt, .pdf.
├── pdf-reader.ts          # Extracción de texto plano desde PDFs.
├── checksum.ts            # findAllFiles(), SHA256 manifest, detección de cambios.
├── types.ts               # Tipos compartidos (CodeAnalysisNote, CodeAnalysisResult, etc).
├── knowledge/
│   ├── engine.ts          # KnowledgeEngine — orquesta RAG + síntesis.
│   ├── rag-provider.ts    # CuratorRagProvider — wrappea ObsidianRAGProvider.
│   └── synthesis.ts       # KnowledgeSynthesizer — genera notas sintéticas con LLM.
└── providers/
    ├── types.ts            # Interfaz CuratorLLMProvider.
    ├── index.ts            # createProvider() factory.
    ├── openai-adapter.ts   # Adaptador OpenAI-compatible (DeepSeek, Ollama, OpenAI).
    └── anthropic-adapter.ts # Adaptador Anthropic Claude directo.
```

## Flujo de curación de código

```
curate_path(path)
    │
    ├─ fs.stat(path)
    │   ├─ isFile → analyzer.analyzeFile(path, relativePath)
    │   └─ isDir  → findAllFiles(path) → background batch processing
    │
    └─ CodeAnalyzer.analyzeFile(filePath, relativePath, allFiles?)
        │
        ├─ isDocFile(.md/.txt/.pdf) → DocumentationCurator.curateFile()
        │       ├─ .pdf → extractPdfText() → texto plano
        │       ├─ .md/.txt → fs.readFile()
        │       └─ callLLM(text) → notas structuradas → writeNote()
        │
        └─ isCodeFile(.ts/.js/.py/...) → analyzeCode()
                ├─ fs.readFile(filePath)
                ├─ findAssociatedDocs() → busca .md asociados, README
                ├─ buildContext() → code + docContent + readmeContent
                ├─ callLLM(context) → JSON con array de notes
                └─ writeNote() × N → vault/{area}/{date}-{slug}.md
```

## Flujo de búsqueda semántica

```
search_vault(query, topK, autoSynthesize)
    │
    └─ KnowledgeEngine.search(query, opts)
            │
            ├─ isInitialized? No → initialize() → CuratorRagProvider.indexVault()
            │       └─ ObsidianRAGProvider.index() → lee .md del vault → embeddings
            │
            ├─ CuratorRagProvider.search(query, {topK})
            │       └─ ObsidianRAGProvider.search() → cosine similarity → top-K results
            │
            └─ autoSynthesize?
                    └─ KnowledgeSynthesizer.synthesize(query, results)
                            ├─ LLM call → markdown synthesis
                            └─ saveNote() → vault/synthesis/{date}-{slug}-v1.md
```

## Detección de proyecto

```
resolveProject()
    │
    ├─ startPath = CODEX_PROJECT_PATH ?? process.cwd()
    │
    ├─ execSync('git rev-parse --show-toplevel', { cwd: startPath })
    │   ├─ OK  → projectRoot = gitRoot, projectName = basename(gitRoot)
    │   └─ Err → projectRoot = startPath, projectName = basename(startPath)
    │
    └─ vaultPath = ~/.codex-vaults/{projectName}/
           └─ fs.mkdir(vaultPath, { recursive: true })
```

## Transportes MCP

El servidor crea **una instancia de McpServer** por conexión:

- **Stdio**: una instancia creada en `main()`, vive toda la sesión. Usado por Claude Code.
- **HTTP**: una instancia nueva por request a `POST /mcp`. Stateless, para clientes remotos.

Ambos transportes exponen exactamente las mismas 4 tools con el mismo `KnowledgeEngine` compartido en memoria.

## Indexado RAG

El índice vive en `~/.codex-context/rag/{vault-name}.json`. Es un archivo JSON con:
- Lista de chunks (fragmentos de notas)
- Embeddings vectoriales por chunk (generados con `SimpleEmbedder`)
- Metadata: path, title, score

Se genera la primera vez que se llama `search_vault` o `vault_status({ reload: true })`. Las búsquedas posteriores usan el índice en memoria (no re-lee el archivo).

## Manifest SHA256

El manifest `.codex-manifest.json` vive en el directorio de entrada analizado. Contiene el hash SHA256 de cada archivo procesado. En ejecuciones posteriores de `curate_path(directory)`:

1. Se calcula el hash del archivo actual
2. Se compara con el hash guardado
3. Si es igual → skip (sin llamada al LLM)
4. Si cambió → re-analiza → actualiza manifest

Esto hace que `curate_path` sobre un directorio grande sea barato después de la primera ejecución.

## Modelo de datos — nota curada

```typescript
interface CodeAnalysisNote {
    type: 'componente' | 'api' | 'patron' | 'utilidad' | 'arquitectura' | 'integracion';
    area: 'general' | 'backend' | 'frontend' | 'devops' | 'infraestructura';
    title: string;        // max 120 chars, searchable
    resumen: string;      // max 500 chars, denso en términos clave
    content: string;      // Markdown con ## headings
    tags: string[];       // ["code/typescript", "modulo/auth", "patron/jwt"]
    language?: string;    // typescript, python, go, etc.
    files?: string[];     // paths relativos de archivos analizados
    depends_on?: string[]; // dependencias externas
    exports?: string[];   // APIs públicas exportadas
    version?: number;
}
```

Guardada como:
```
vault/{area}/{YYYY-MM-DD}-{slug}.md
```

Con frontmatter YAML completo + contenido Markdown.
