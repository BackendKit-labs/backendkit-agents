# Soporte PDF

## Cómo funciona

El agente extrae el texto plano de un PDF y lo manda al mismo pipeline LLM que los archivos `.md` y `.txt`. No hay OCR — solo extracción de texto de PDFs que ya tienen texto embebido (la gran mayoría de PDFs generados digitalmente).

### Flujo

```
curate_path("documento.pdf")
    → DocumentationCurator.curateFile("documento.pdf")
    → extractPdfText("documento.pdf")         ← pdf-reader.ts
        → fs.readFile() → Buffer
        → pdfParse(buffer) → { text, numpages }
    → curateText(text, "documento.pdf (42 pages)", areaHint?)
    → LLM analiza el texto
    → Notas estructuradas guardadas en vault/
```

### Módulo pdf-reader.ts

```typescript
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

export async function extractPdfText(filePath: string): Promise<PdfContent> {
    const pdfParse = require('pdf-parse');
    const buffer = await fs.readFile(filePath);
    const data = await pdfParse(buffer);
    return {
        text: data.text.trim(),
        pages: data.numpages,
        filename: path.basename(filePath),
    };
}
```

`pdf-parse` es una librería CJS (CommonJS). El agente usa `createRequire` para cargarla de forma compatible con el módulo ESM/NodeNext del proyecto.

## Librería: pdf-parse v2

- **Package**: `pdf-parse@^2.4.5`
- **Engine**: `pdfjs-dist` internamente
- **Requiere**: Node.js >= 20.16.0 o >= 22.3.0
- **Limitaciones**: solo PDFs con texto embebido (no imágenes escaneadas)

## Tipos de PDF soportados

### Soportados

- PDFs generados desde Word, Google Docs, LibreOffice
- PDFs de LaTeX / Typst
- PDFs exportados desde Figma, Notion, Confluence
- Manuales técnicos y documentación de APIs en PDF
- Reportes y presentaciones con texto
- PDFs de contratos y documentos legales

### No soportados

- PDFs escaneados (imágenes de papel) — solo contienen píxeles, sin texto
- PDFs protegidos con contraseña de lectura
- PDFs con texto codificado en fuentes propietarias sin mapa de caracteres

### Señales de que un PDF no tiene texto extraíble

Si `extractPdfText()` retorna texto vacío o muy corto para un PDF grande, probablemente es un PDF escaneado. En ese caso el agente retornará un error de "no enterprise relevance" del LLM.

## Source ref en las notas generadas

El campo `source_ref` del frontmatter incluye el número de páginas:

```yaml
source_ref: "arquitectura-microservicios.pdf (24 pages)"
```

Esto ayuda a identificar la fuente cuando se lee la nota en el vault.

## Truncado de texto

El `DocumentationCurator` trunca el texto al `maxInputChars` (default: 12,000 caracteres) antes de mandarlo al LLM. Para PDFs largos esto significa que solo se analiza el inicio del documento.

Para documentos extensos se recomienda dividirlos en secciones o configurar `maxInputChars` más alto si el modelo lo permite.

## Integración con el manifest SHA256

Los PDFs se incluyen en el manifest de la misma forma que los archivos de texto. El hash SHA256 del archivo binario se guarda. En ejecuciones posteriores, si el PDF no cambió → skip sin llamada al LLM.

## Casos de uso típicos

```
# Manual técnico de una API externa
curate_path("/project/docs/stripe-api-reference.pdf")
search_vault("stripe webhook signature verification")

# Documento de arquitectura del equipo
curate_path("/project/docs/arquitectura-sistema.pdf")
search_vault("decisiones de diseño del sistema de cache")

# Especificación funcional
curate_path("/project/docs/PRD-v2.pdf")
search_vault("requisitos del módulo de pagos")

# RFC o ADR en PDF
curate_path("/project/docs/ADR-001-database-selection.pdf")
search_vault("por qué PostgreSQL en lugar de MongoDB")
```
