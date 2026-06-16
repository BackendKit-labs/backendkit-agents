# Vault — Estructura y formato de notas

## Ubicación

```
~/.codex-vaults/
└── {nombre-del-proyecto}/      ← git root basename o basename de CWD
    ├── general/                ← notas sin área específica
    ├── backend/                ← código de backend
    ├── frontend/               ← código de frontend
    ├── devops/                 ← CI/CD, infraestructura
    ├── infraestructura/        ← cloud, redes, configuración
    └── synthesis/              ← notas generadas por search_vault
```

Las carpetas se crean automáticamente cuando el LLM asigna el `area` a una nota.

## Nombre de archivos

```
{YYYY-MM-DD}-{slug}.md
```

Ejemplos:
```
2026-06-16-auth-service-jwt-token-generation.md
2026-06-16-stripe-payment-integration-webhook.md
2026-06-16-arquitectura-microservicios-decision.md
```

El slug se genera desde el `title` de la nota: lowercase, sin acentos, sin caracteres especiales, máximo 60 caracteres. Si ya existe un archivo con el mismo nombre → skip (deduplicación automática).

## Formato de notas de código

```markdown
---
title: "AuthService: JWT token generation and refresh"
area: backend
tipo: componente
language: typescript
resumen: "NestJS service implementing JWT login with access/refresh token pair, validateToken checks expiry and signature, refreshToken rotates tokens. Depends on @nestjs/jwt and @backendkit-labs/result."
author: "agent/codex"
date: 2026-06-16
source_ref: "auth.service.ts"
sources_combined: ["src/auth/auth.service.ts", "src/auth/auth.md"]
tags: ["code/typescript", "modulo/auth", "patron/jwt", "patron/refresh-token"]
exports: ["AuthService", "login", "validateToken", "refreshToken", "AuthTokenPair"]
depends_on: ["@nestjs/jwt", "@backendkit-labs/result", "@nestjs/common"]
files: ["src/auth/auth.service.ts"]
---

## Overview

Breve descripción del componente y su rol en el sistema.

## Public API

### `login(credentials): Promise<AuthTokenPair>`

Descripción del método, parámetros, retorno.

### `validateToken(token: string): Promise<JwtPayload>`

...

## Usage Examples

```typescript
const tokens = await authService.login({ email, password });
const payload = await authService.validateToken(tokens.accessToken);
```

## Dependencies

- `@nestjs/jwt` — firma y verificación de tokens
- `@backendkit-labs/result` — manejo de errores tipado

## Notes

Observaciones sobre edge cases, limitaciones, etc.
```

## Campos del frontmatter

### Campos de código

| Campo | Tipo | Descripción |
|---|---|---|
| `title` | string | Título específico y buscable, max 120 chars |
| `area` | enum | `general`, `backend`, `frontend`, `devops`, `infraestructura` |
| `tipo` | enum | `componente`, `api`, `patron`, `utilidad`, `arquitectura`, `integracion` |
| `language` | string | `typescript`, `python`, `go`, `rust`, etc. |
| `resumen` | string | 1-2 frases densas en términos buscables, max 500 chars |
| `author` | string | Siempre `"agent/codex"` |
| `date` | date | Fecha de creación `YYYY-MM-DD` |
| `source_ref` | string | Nombre del archivo principal analizado |
| `sources_combined` | string[] | Todos los archivos que contribuyeron al análisis (código + docs asociadas) |
| `tags` | string[] | Etiquetas jerárquicas: `code/typescript`, `modulo/auth`, `patron/jwt` |
| `exports` | string[] | Funciones, clases, interfaces públicas exportadas |
| `depends_on` | string[] | Dependencias externas e internas |
| `files` | string[] | Paths relativos de archivos analizados |
| `version` | number | Versión si el código la tiene |

### Campos de documentación

| Campo | Tipo | Descripción |
|---|---|---|
| `title` | string | Título del documento |
| `area` | enum | `rrhh`, `finanzas`, `operaciones`, `ventas`, `soporte`, `legal`, `calidad`, `general` |
| `tipo` | enum | `politica`, `decision`, `procedimiento`, `leccion`, `norma_externa` |
| `resumen` | string | Resumen denso con términos, fechas, montos, nombres propios |
| `vigente_desde` | date | Fecha de vigencia |
| `expires_at` | date | Fecha de expiración |
| `decidido_por` | string[] | Quiénes tomaron la decisión |
| `aplica_a` | string[] | A quiénes aplica |

### Campos de síntesis

| Campo | Tipo | Descripción |
|---|---|---|
| `area` | string | Siempre `synthesis` |
| `tipo` | string | Siempre `synthesis` |
| `generated_by` | string | Siempre `knowledge-agent` |
| `synthesis_version` | number | Versión de la síntesis |
| `based_on` | string[] | Títulos de las notas fuente usadas |

## Formato de notas de síntesis

Las notas de síntesis se generan automáticamente por `search_vault` con `autoSynthesize: true`. Combinan el contenido de múltiples notas en una guía coherente que responde directamente a la query.

```markdown
---
title: "cómo funciona la autenticación JWT — Synthesis"
area: synthesis
tipo: synthesis
generated_by: knowledge-agent
synthesis_version: 1
based_on: ["AuthService: JWT token generation", "JwtMiddleware: token validation", "RefreshToken strategy"]
date: 2026-06-16
author: "agent/codex"
tags: ["synthesis", "generated"]
---

## Síntesis

Contenido generado por LLM que integra las notas fuente...
```

## Convenciones de tags

```
code/{language}        → code/typescript, code/python, code/go
modulo/{name}          → modulo/auth, modulo/payments, modulo/users
patron/{pattern}       → patron/jwt, patron/repository, patron/cqrs
area/{domain}          → area/backend, area/frontend
tipo/{type}            → tipo/componente, tipo/api, tipo/utilidad
synthesis              → nota de síntesis automática
generated              → generada por el agente
```

## Deduplicación

El agente nunca sobreescribe una nota existente. Si ya existe `{date}-{slug}.md`, la nota se marca como `skipped`. Para forzar re-análisis de un archivo hay que:
1. Borrar la nota del vault manualmente
2. Llamar `curate_path` de nuevo
3. Llamar `vault_status({ reload: true })` para reindexar
