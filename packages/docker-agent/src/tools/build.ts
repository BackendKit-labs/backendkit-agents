import { execFile } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { defineTool, z } from '@backendkit-labs/agent-core';

function execCmd(
  cmd: string,
  args: string[],
  cwd: string,
  env?: Record<string, string>,
  timeoutMs = 300_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env: env ? { ...process.env, ...env } : process.env,
    }, (err, stdout, stderr) => {
      if (err) { reject(new Error(stderr.trim() || err.message)); return; }
      const out = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
      resolve(out || `${cmd} completed successfully`);
    });
  });
}

function detectPackageManager(projectPath: string): 'pnpm' | 'yarn' | 'npm' {
  if (existsSync(join(projectPath, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(projectPath, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

export const buildDetect = defineTool({
  name: 'build_detect',
  description: 'Detect the language and build system used in a project directory',
  input: z.object({
    path: z.string().describe('Absolute path to the project directory'),
  }),
  async execute({ path }) {
    const checks: Array<{ file: string; language: string; buildTool: string; notes?: string }> = [
      { file: 'package.json', language: 'Node.js', buildTool: 'build_node' },
      { file: 'go.mod', language: 'Go', buildTool: 'build_go' },
      { file: 'pyproject.toml', language: 'Python', buildTool: 'build_python', notes: 'PEP 517/518' },
      { file: 'setup.py', language: 'Python', buildTool: 'build_python' },
      { file: 'requirements.txt', language: 'Python', buildTool: 'build_python' },
      { file: 'Cargo.toml', language: 'Rust', buildTool: 'none â€” not yet supported' },
      { file: 'pom.xml', language: 'Java', buildTool: 'none â€” not yet supported', notes: 'Maven' },
      { file: 'build.gradle', language: 'Java', buildTool: 'none â€” not yet supported', notes: 'Gradle' },
      { file: 'Makefile', language: 'generic', buildTool: 'none â€” run make manually via container_exec' },
    ];

    const detected = checks.filter(c => existsSync(join(path, c.file)));
    const hasDockerfile = existsSync(join(path, 'Dockerfile'));

    if (detected.length === 0 && !hasDockerfile) {
      return `No recognized build system found in: ${path}`;
    }

    const result: Record<string, unknown> = { path, detected: detected.map(c => ({ ...c, found: c.file })) };

    if (hasDockerfile) result.docker = { file: 'Dockerfile', buildTool: 'image_build' };

    // Extra detail for Node.js
    const nodeEntry = detected.find(c => c.file === 'package.json');
    if (nodeEntry) {
      try {
        const pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf-8')) as {
          scripts?: Record<string, string>;
        };
        result.nodeScripts = Object.keys(pkg.scripts ?? {});
        result.packageManager = detectPackageManager(path);
      } catch { /* ignore */ }
    }

    return JSON.stringify(result);
  },
});

export const buildNode = defineTool({
  name: 'build_node',
  description: 'Install dependencies and build a Node.js project (auto-detects npm/yarn/pnpm)',
  input: z.object({
    path: z.string().describe('Absolute path to the project directory (must contain package.json)'),
    script: z.string().optional().describe('npm script to run after install (default: "build"). Pass empty string to skip.'),
    packageManager: z.enum(['auto', 'npm', 'yarn', 'pnpm']).optional().describe('Package manager (default: auto-detect from lockfile)'),
    ci: z.boolean().optional().describe('Use clean install (npm ci / yarn install --frozen-lockfile / pnpm install --frozen-lockfile)'),
    env: z.record(z.string()).optional().describe('Extra environment variables for the build (e.g. NODE_ENV=production)'),
  }),
  async execute({ path, script = 'build', packageManager = 'auto', ci = false, env }) {
    const pm = packageManager === 'auto' ? detectPackageManager(path) : packageManager;

    // Install
    let installArgs: string[];
    if (pm === 'npm') {
      installArgs = ci ? ['ci'] : ['install'];
    } else if (pm === 'yarn') {
      installArgs = ci ? ['install', '--frozen-lockfile'] : ['install'];
    } else {
      installArgs = ci ? ['install', '--frozen-lockfile'] : ['install'];
    }
    const installOut = await execCmd(pm, installArgs, path, env);

    if (!script) return installOut;

    // Build
    const buildOut = await execCmd(pm, ['run', script], path, env);
    return [installOut, buildOut].join('\n---\n');
  },
});

export const buildPython = defineTool({
  name: 'build_python',
  description: 'Install dependencies and optionally build a Python project (pip/pyproject.toml)',
  input: z.object({
    path: z.string().describe('Absolute path to the project directory'),
    extras: z.array(z.string()).optional().describe('pip extras to install (e.g. ["dev", "test"])'),
    buildWheel: z.boolean().optional().describe('Build distributable wheel via `python -m build` (requires build package)'),
    env: z.record(z.string()).optional().describe('Extra environment variables for the build'),
  }),
  async execute({ path, extras = [], buildWheel = false, env }) {
    const hasPyproject = existsSync(join(path, 'pyproject.toml'));
    const hasSetupPy = existsSync(join(path, 'setup.py'));
    const hasRequirements = existsSync(join(path, 'requirements.txt'));

    let installOut: string;

    if (hasRequirements) {
      installOut = await execCmd('pip', ['install', '-r', 'requirements.txt'], path, env);
    } else if (hasPyproject || hasSetupPy) {
      const spec = extras.length ? `.[${extras.join(',')}]` : '.';
      installOut = await execCmd('pip', ['install', spec], path, env);
    } else {
      return `No requirements.txt, pyproject.toml, or setup.py found in: ${path}`;
    }

    if (!buildWheel) return installOut;

    const buildOut = await execCmd('python', ['-m', 'build', '--wheel', path], path, env);
    return [installOut, buildOut].join('\n---\n');
  },
});

export const buildGo = defineTool({
  name: 'build_go',
  description: 'Build a Go project using `go build`',
  input: z.object({
    path: z.string().describe('Absolute path to the project directory (must contain go.mod)'),
    output: z.string().optional().describe('Output binary path relative to the project (e.g. bin/myapp)'),
    target: z.string().optional().describe('Build target (default: "./...")'),
    ldflags: z.string().optional().describe('Linker flags (e.g. "-s -w -X main.version=1.0.0")'),
    env: z.record(z.string()).optional().describe('Extra env vars (e.g. { "GOOS": "linux", "GOARCH": "amd64" } for cross-compilation)'),
  }),
  async execute({ path, output, target = './...', ldflags, env }) {
    const args = ['build'];
    if (output) args.push('-o', output);
    if (ldflags) args.push('-ldflags', ldflags);
    args.push(target);
    return execCmd('go', args, path, env);
  },
});

