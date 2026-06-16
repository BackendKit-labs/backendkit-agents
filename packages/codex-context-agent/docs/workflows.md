# Workflows — Patrones de uso

## Workflow 1: Onboarding a un proyecto nuevo

Cuando llegás a un proyecto que no conocés o que no tiene vault todavía.

```
# Paso 1: verificar que el agente detectó el proyecto correcto
vault_status()
→ { project: "mi-proyecto", vaultPath: "~/.codex-vaults/mi-proyecto", noteCount: 0 }

# Paso 2: curar el código fuente completo
curate_path("/ruta/absoluta/al/proyecto/src")
→ { status: "processing", totalFiles: 84, ... }

# Paso 3: curar documentación si existe
curate_path("/ruta/absoluta/al/proyecto/docs")
→ { status: "processing", totalFiles: 12, ... }

# Paso 4: esperar que termine el background processing
# (84 archivos × ~5s promedio = ~7 minutos con deepseek-reasoner)

# Paso 5: reindexar el vault
vault_status({ reload: true })
→ { noteCount: 67, engine: { initialized: true } }

# Paso 6: empezar a consultar
search_vault("arquitectura general del sistema")
search_vault("cómo se manejan los errores")
search_vault("qué hace el módulo de autenticación")
```

## Workflow 2: Desarrollo activo — nuevo feature

Trabajando en un feature, necesitás entender código existente antes de modificarlo.

```
# Entender el área donde vas a trabajar
search_vault("payments module stripe webhook")

# Leer la nota más relevante completa
read_note("stripe payment integration")

# Curar el archivo nuevo que vas a crear o modificar
curate_path("/project/src/payments/refund.service.ts")
vault_status({ reload: true })

# Verificar que el conocimiento del nuevo archivo está disponible
search_vault("refund service implementation")
```

## Workflow 3: Code review con contexto

Revisando un PR y necesitás entender el impacto de los cambios.

```
# Entender el componente modificado
search_vault("UserRepository database queries")

# Entender las dependencias
search_vault("qué usa UserRepository")

# Leer la nota completa del componente
read_note("UserRepository")
```

## Workflow 4: Debugging — entender el sistema

Hay un bug en producción y necesitás entender rápido cómo funciona el sistema.

```
# Buscar el área del bug
search_vault("token refresh failure expired")

# Buscar patrones de error conocidos
search_vault("error handling authentication middleware")

# Buscar la configuración relevante
search_vault("JWT expiry configuration environment variables")
```

## Workflow 5: Documentación mezclada con código

Proyecto que tiene PDFs de arquitectura, ADRs, y código fuente.

```
# Curar todo junto
curate_path("/project/src")          # código
curate_path("/project/docs")         # .md y PDFs
curate_path("/project/adr")          # Architecture Decision Records

vault_status({ reload: true })

# Consulta cross-cutting
search_vault("por qué se eligió PostgreSQL sobre MongoDB")
→ retorna notas del ADR + notas de código que usan PostgreSQL

search_vault("rate limiting implementation decision")
→ retorna ADR de rate limiting + código del middleware
```

## Workflow 6: Mantener el vault actualizado

El proyecto evoluciona y el vault queda desactualizado.

```
# Curar solo los archivos modificados recientemente
# (el manifest detecta automáticamente qué cambió)
curate_path("/project/src")
→ solo procesa archivos con hash SHA256 diferente al guardado

vault_status({ reload: true })
```

El manifest `.codex-manifest.json` en el directorio de entrada registra el hash de cada archivo. Si un archivo no cambió desde la última curación → se saltea sin llamada al LLM.

## Estimaciones de tiempo

| Operación | Tiempo aproximado |
|---|---|
| `curate_path` — archivo solo | 3-8 segundos |
| `curate_path` — 10 archivos | 30-80 segundos |
| `curate_path` — 100 archivos | 8-15 minutos |
| `curate_path` — 500 archivos | 40-90 minutos |
| `curate_path` — ya procesado (manifest hit) | < 100ms por archivo |
| `search_vault` — primera vez (init RAG) | 5-15 segundos |
| `search_vault` — subsiguientes | 200-800ms |
| `vault_status({ reload: true })` — 50 notas | 2-5 segundos |
| `read_note` | < 100ms |

Con `CODEX_PROVIDER=deepseek, CODEX_MODEL=deepseek-chat` los tiempos de curación son 2-3x más rápidos (menor calidad de análisis).

## Tips generales

### Curar antes de preguntar
El vault vacío no puede responder. Curá el código relevante antes de la primera sesión de trabajo.

### Reload explícito
`curate_path` con directorio procesa en background. Siempre hacer `vault_status({ reload: true })` cuando terminó antes de buscar.

### Preguntas técnicas específicas
`search_vault` trabaja mejor con términos técnicos del código que con descripciones en lenguaje natural.

### read_note para contexto completo
Los resultados de `search_vault` muestran fragmentos. Si necesitás el API completo de un componente, usá `read_note` para leer la nota entera.

### El vault persiste entre sesiones
No necesitás curar el mismo código cada vez. El vault y el índice RAG sobreviven cierres de Claude Code.
