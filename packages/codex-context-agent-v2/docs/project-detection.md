# Detección de proyecto y resolución del vault

## Lógica de resolución

El módulo `project.ts` resuelve el contexto del proyecto al arrancar el servidor. Se ejecuta una sola vez en `main()`.

```typescript
export async function resolveProject(): Promise<ProjectContext> {
    const startPath = process.env.CODEX_PROJECT_PATH ?? process.cwd();

    let projectRoot: string;
    let projectName: string;

    try {
        // Intenta encontrar el git root
        const gitRoot = execSync('git rev-parse --show-toplevel', {
            cwd: startPath,
            encoding: 'utf-8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        projectRoot = gitRoot;
        projectName = path.basename(gitRoot);
    } catch {
        // No es un repo git — usa el startPath directamente
        projectRoot = startPath;
        projectName = path.basename(startPath);
    }

    const vaultPath = path.join(os.homedir(), '.codex-vaults', projectName);
    await fs.mkdir(vaultPath, { recursive: true });

    return { projectName, projectRoot, vaultPath };
}
```

## Prioridad de resolución

```
1. CODEX_PROJECT_PATH (env var explícita)
        ↓ si no está definida
2. process.cwd() al momento de iniciar el servidor
        ↓
3. git rev-parse --show-toplevel desde ese path
        ↓ si no es git repo
4. El path directamente (basename como nombre)
```

## Vault path resultante

```
~/.codex-vaults/{basename(git-root)}/
```

Ejemplos:

| Proyecto | Git root | Vault |
|---|---|---|
| `backendkit-agents` | `/home/user/dev/backendkit-agents` | `~/.codex-vaults/backendkit-agents/` |
| `my-api` | `/home/user/work/my-api` | `~/.codex-vaults/my-api/` |
| Sin git | `/home/user/scripts` | `~/.codex-vaults/scripts/` |

## Instancia única por sesión de Claude Code

El servidor MCP se lanza una vez cuando Claude Code abre el proyecto y permanece corriendo hasta que se cierra. El vault queda fijo en esa sesión.

Si Claude Code abre siempre los proyectos desde sus raíces (lo más común), esto funciona perfectamente. Si abrís un subdirectorio, `git rev-parse --show-toplevel` igual encuentra el root correcto.

## CODEX_PROJECT_PATH — cuándo usarlo

### Configuración en settings.json del proyecto

La forma recomendada para equipos: cada proyecto tiene su `.claude/settings.json` con el path hardcodeado.

```json
{
  "mcpServers": {
    "codex-context": {
      "env": {
        "CODEX_PROJECT_PATH": "/home/user/dev/backendkit-agents"
      }
    }
  }
}
```

Ventajas:
- El vault siempre es correcto sin importar cómo se inicia Claude Code
- El path se puede commitear (sin secrets)
- Reproducible en otros equipos (cambiando el path)

### Configuración global sin path fijo

Si usás la configuración global (`~/.claude/settings.json`) sin `CODEX_PROJECT_PATH`, el agente usa el CWD. Esto funciona bien si:

- Siempre abrís Claude Code desde la raíz del proyecto
- Trabajás en un solo proyecto a la vez
- El proyecto es un git repo

## Búsqueda de nota por título — findNote()

La función `findNote(vaultPath, pathOrTitle)` en `project.ts` implementa la búsqueda para `read_note`:

```typescript
export async function findNote(vaultPath: string, pathOrTitle: string): Promise<string> {
    // Si parece un path → leer directo
    if (pathOrTitle.includes('/') || pathOrTitle.includes('\\') || pathOrTitle.endsWith('.md')) {
        const resolved = path.isAbsolute(pathOrTitle)
            ? pathOrTitle
            : path.join(vaultPath, pathOrTitle);
        return await fs.readFile(resolved, 'utf-8');
    }

    // Buscar en vault por nombre de archivo
    const searchTerm = pathOrTitle.toLowerCase().replace(/\s+/g, '-');
    const found = await scanVaultForTitle(vaultPath, searchTerm);

    // Si hay múltiples matches → el más reciente
    const stats = await Promise.all(found.map(f => ({ path: f, mtime: ... })));
    stats.sort((a, b) => b.mtime - a.mtime);
    return await fs.readFile(stats[0].path, 'utf-8');
}
```

### Ejemplo de match

Si el vault tiene `backend/2026-06-16-auth-service-jwt-token-generation.md`:

```
read_note("auth service")     → match ("auth-service" en el nombre)
read_note("jwt token")        → match ("jwt-token" en el nombre)
read_note("auth")             → match (substring)
read_note("AuthService JWT")  → match ("authservice-jwt" → "auth" y "jwt" en el nombre)
```

La búsqueda es case-insensitive y transforma los espacios en guiones antes de comparar.
