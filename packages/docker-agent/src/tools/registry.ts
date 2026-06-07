import { execFile, spawn } from 'child_process';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { defineTool, z } from '@backendkit-labs/agent-core';
import { loadConfig } from '../config';

function execDocker(args: string[], timeoutMs?: number): Promise<string> {
  const timeout = timeoutMs ?? loadConfig().defaultTimeout;
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { reject(new Error(stderr.trim() || err.message)); return; }
      resolve(stdout.trim());
    });
  });
}

function spawnDockerLogin(args: string[], password: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('docker', args, { timeout: 30_000 });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code !== 0) reject(new Error(stderr.trim() || `docker login exited with code ${code}`));
      else resolve(stdout.trim() || stderr.trim());
    });
    proc.stdin.write(password);
    proc.stdin.end();
  });
}

function getDockerAuth(registry: string): string | null {
  try {
    const config = JSON.parse(readFileSync(join(homedir(), '.docker', 'config.json'), 'utf-8')) as {
      auths?: Record<string, { auth?: string }>;
    };
    const auths = config.auths ?? {};
    return (
      auths[registry]?.auth ??
      auths[`https://${registry}`]?.auth ??
      auths[`${registry}/v1/`]?.auth ??
      null
    );
  } catch {
    return null;
  }
}

interface ParsedRef { registry: string | null; namespace: string; repo: string }

function parseImageRef(image: string): ParsedRef {
  const name = image.split('@')[0].split(':')[0];
  const parts = name.split('/');

  if (parts.length === 1) return { registry: null, namespace: 'library', repo: parts[0] };

  const isRegistry = parts[0].includes('.') || parts[0].includes(':') || parts[0] === 'localhost';

  if (parts.length === 2) {
    return isRegistry
      ? { registry: parts[0], namespace: '', repo: parts[1] }
      : { registry: null, namespace: parts[0], repo: parts[1] };
  }

  return isRegistry
    ? { registry: parts[0], namespace: parts[1], repo: parts.slice(2).join('/') }
    : { registry: null, namespace: parts[0], repo: parts.slice(1).join('/') };
}

async function registryFetch(url: string, basicAuth: string | null): Promise<Response> {
  const headers: Record<string, string> = {};
  if (basicAuth) headers['Authorization'] = `Basic ${basicAuth}`;

  let res = await fetch(url, { headers });
  if (res.status !== 401) return res;

  const wwwAuth = res.headers.get('www-authenticate') ?? '';
  if (!wwwAuth.startsWith('Bearer ')) return res;

  const realm = wwwAuth.match(/realm="([^"]+)"/)?.[1];
  const service = wwwAuth.match(/service="([^"]+)"/)?.[1];
  const scope = wwwAuth.match(/scope="([^"]+)"/)?.[1];

  if (!realm) return res;

  const tokenUrl = new URL(realm);
  if (service) tokenUrl.searchParams.set('service', service);
  if (scope) tokenUrl.searchParams.set('scope', scope);

  const tokenHeaders: Record<string, string> = {};
  if (basicAuth) tokenHeaders['Authorization'] = `Basic ${basicAuth}`;

  const tokenRes = await fetch(tokenUrl.toString(), { headers: tokenHeaders });
  if (!tokenRes.ok) return res;

  const tokenData = await tokenRes.json() as { token?: string; access_token?: string };
  const token = tokenData.token ?? tokenData.access_token;
  if (!token) return res;

  res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return res;
}

export const registryLogin = defineTool({
  name: 'registry_login',
  description: 'Authenticate with a Docker registry (Docker Hub, ECR, GCR, Harbor, etc.)',
  input: z.object({
    username: z.string().describe('Registry username or access key'),
    password: z.string().describe('Password or access token (passed via stdin, not logged)'),
    registry: z.string().optional().describe('Registry hostname (default: Docker Hub)'),
  }),
  async execute({ username, password, registry }) {
    const args = ['login', '--username', username, '--password-stdin'];
    if (registry) args.push(registry);
    const result = await spawnDockerLogin(args, password);
    return result.includes('Login Succeeded') ? `Login succeeded${registry ? ` for ${registry}` : ''}` : result;
  },
});

export const registryLogout = defineTool({
  name: 'registry_logout',
  description: 'Log out from a Docker registry and remove stored credentials',
  input: z.object({
    registry: z.string().optional().describe('Registry hostname (default: Docker Hub)'),
  }),
  async execute({ registry }) {
    const args = ['logout'];
    if (registry) args.push(registry);
    return execDocker(args);
  },
});

export const registrySearch = defineTool({
  name: 'registry_search',
  description: 'Search Docker Hub for public images',
  input: z.object({
    query: z.string().describe('Search term (e.g. "nginx", "postgres", "myorg/myapp")'),
    limit: z.number().optional().describe('Max results (default: 10, max: 100)'),
    official: z.boolean().optional().describe('Filter to official images only'),
  }),
  async execute({ query, limit = 10, official }) {
    const args = ['search', '--format', '{{json .}}', '--limit', String(Math.min(limit, 100))];
    if (official) args.push('--filter', 'is-official=true');
    args.push(query);

    const output = await execDocker(args);
    if (!output) return `No results for: ${query}`;

    const results = output.split('\n')
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);

    return JSON.stringify(results);
  },
});

export const registryTags = defineTool({
  name: 'registry_tags',
  description: 'List available tags for an image in Docker Hub or a private v2 registry',
  input: z.object({
    image: z.string().describe('Image name (e.g. "nginx", "myuser/myapp", "registry.io/myapp")'),
    limit: z.number().optional().describe('Max tags to return (default: 20)'),
  }),
  async execute({ image, limit = 20 }) {
    const { registry, namespace, repo } = parseImageRef(image);

    const isDockerHub = !registry || registry === 'docker.io' || registry === 'registry-1.docker.io';

    if (isDockerHub) {
      const ns = namespace || 'library';
      const url = `https://hub.docker.com/v2/repositories/${ns}/${repo}/tags?page_size=${limit}&ordering=last_updated`;
      const res = await fetch(url);
      if (res.status === 404) return `Image not found on Docker Hub: ${ns}/${repo}`;
      if (!res.ok) return `Docker Hub API error: ${res.status} ${res.statusText}`;

      const data = await res.json() as {
        results?: Array<{ name: string; last_updated: string; full_size: number }>;
      };
      const tags = (data.results ?? []).map(t => ({
        tag: t.name,
        lastUpdated: t.last_updated,
        sizeMB: parseFloat((t.full_size / 1024 / 1024).toFixed(1)),
      }));
      return JSON.stringify(tags);
    }

    // Generic v2 registry
    const repoPath = namespace ? `${namespace}/${repo}` : repo;
    const url = `https://${registry}/v2/${repoPath}/tags/list`;
    const basicAuth = getDockerAuth(registry);

    const res = await registryFetch(url, basicAuth);
    if (!res.ok) return `Registry API error ${res.status}: ${res.statusText}. Run registry_login first if this is a private registry.`;

    const data = await res.json() as { tags?: string[] };
    const tags = (data.tags ?? []).slice(0, limit).sort();
    return JSON.stringify({ registry, image: repoPath, tags });
  },
});

