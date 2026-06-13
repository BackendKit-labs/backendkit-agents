# Curator-Codex Workspaces

Organiza múltiples vaults por tema usando **workspaces**. Cada workspace tiene su propio `inputPath` y `outputPath`.

## Archivo de Configuración

Workspaces se guardan en `.bk-agent/curator-workspace.json`:

```json
{
  "workspaces": [
    {
      "name": "backend",
      "inputPath": "C:\\Users\\mairon.cuello\\desarrollo\\backend-api",
      "outputPath": "C:\\Users\\mairon.cuello\\vaults\\vault-backend",
      "description": "Backend projects and patterns"
    },
    {
      "name": "security",
      "inputPath": "C:\\Users\\mairon.cuello\\desarrollo\\security-patterns",
      "outputPath": "C:\\Users\\mairon.cuello\\vaults\\vault-security",
      "description": "Security patterns and best practices"
    }
  ],
  "lastUsed": "backend",
  "version": "1.0.0"
}
```

## Cambiar Workspace

### Vía MCP Tool
```bash
curator_workspace_list
```

Retorna los workspaces disponibles.

### Vía HTTP API
```bash
# Listar workspaces
curl http://localhost:3100/curator/workspaces \
  -H "Authorization: Bearer sk-..."

# Cambiar a workspace específico
curl -X POST http://localhost:3100/curator/workspace/backend \
  -H "Authorization: Bearer sk-..."

# Ver config actual
curl http://localhost:3100/curator/config \
  -H "Authorization: Bearer sk-..."
```

### Vía Config File
Edita `.bk-agent/curator-workspace.json` y cambia el campo `"lastUsed"`:

```json
{
  "lastUsed": "security"
}
```

## Flujo de Trabajo Típico

### 1. Listar Workspaces Disponibles
```bash
curator_workspace_list
```

Resultado:
```json
{
  "current": "backend",
  "workspaces": [
    {
      "name": "backend",
      "inputPath": "C:\\...",
      "outputPath": "C:\\vaults\\vault-backend",
      "description": "Backend projects"
    },
    {
      "name": "security",
      "inputPath": "C:\\...",
      "outputPath": "C:\\vaults\\vault-security",
      "description": "Security patterns"
    }
  ]
}
```

### 2. Cambiar Workspace
```bash
# HTTP API
curl -X POST http://localhost:3100/curator/workspace/security \
  -H "Authorization: Bearer sk-..."
```

Resultado:
```json
{
  "success": true,
  "workspace": "security",
  "config": {
    "inputPath": "C:\\...",
    "outputPath": "C:\\vaults\\vault-security",
    "provider": "deepseek",
    "model": "deepseek-reasoner"
  }
}
```

### 3. Procesar Directorio
```bash
curator_process_directory "C:\mi-proyecto"
```

Las notas se guardarán en el `outputPath` del workspace actual.

### 4. Buscar en Vault Actual
```bash
knowledge_search "patrón de autenticación"
```

La búsqueda se realiza en el vault del workspace actual.

## Casos de Uso

| Workspace | Input | Output | Propósito |
|-----------|-------|--------|-----------|
| `backend` | `C:\projects\backend` | `vaults\vault-backend` | APIs, microservicios |
| `security` | `C:\projects\security` | `vaults\vault-security` | Auth, encriptación, vulnerabilidades |
| `devops` | `C:\projects\devops` | `vaults\vault-devops` | Infra, CI/CD, deployments |
| `frontend` | `C:\projects\frontend` | `vaults\vault-frontend` | React, Vue, UI patterns |
| `learning` | `C:\learning\notes` | `vaults\vault-learning` | Personal learning & research |

## Crear Nuevo Workspace

### 1. Edita `.bk-agent/curator-workspace.json`

Agrega entrada en el array `workspaces`:

```json
{
  "name": "my-new-topic",
  "inputPath": "C:\\Users\\mairon.cuello\\desarrollo\\my-topic",
  "outputPath": "C:\\Users\\mairon.cuello\\vaults\\vault-my-topic",
  "description": "My custom topic vault"
}
```

### 2. Reinicia bk-agent

Los cambios se cargan automáticamente.

### 3. Verifica que aparece
```bash
curator_workspace_list
```

## Ventajas de Workspaces

✅ **Organización** — Mantén vaults separados por tema  
✅ **Reproducibilidad** — Mismas rutas en cada sesión  
✅ **Colaboración** — Otros usuarios ven tu setup  
✅ **Búsqueda Targeted** — Limita búsemántica a un tema  
✅ **Escalabilidad** — Crece a cientos de vaults  

## Flujo Ideal

```
Inicio de sesión
     ↓
curator_workspace_list  (ver disponibles)
     ↓
POST /curator/workspace/mi-tema  (cambiar)
     ↓
curator_process_directory "ruta"  (curar archivos)
     ↓
knowledge_search "query"  (buscar en vault)
     ↓
Fin de sesión (lastUsed se guarda automáticamente)
```

## Notas

- **Persistencia**: El campo `lastUsed` se actualiza automáticamente
- **Validación**: Los workspaces no validanque existan las rutas (créalas manualmente)
- **Aislamiento**: Cada workspace es completamente independiente
- **Búsqueda**: `knowledge_search` busca solo en el vault del workspace actual

---

Usa workspaces para mantener tu conocimiento organizado por dominio. 🎯
