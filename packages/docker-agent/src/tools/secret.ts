import { execFile, spawn } from 'child_process';
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

function execVault(args: string[], timeoutMs?: number): Promise<string> {
  const timeout = timeoutMs ?? 15_000;
  return new Promise((resolve, reject) => {
    execFile('vault', args, { timeout, maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { reject(new Error(stderr.trim() || err.message)); return; }
      resolve(stdout.trim());
    });
  });
}

// Pipe value via stdin to avoid it appearing in process args
function spawnDockerSecretCreate(name: string, value: string, labels: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = ['secret', 'create'];
    labels.forEach(l => args.push('--label', l));
    args.push(name, '-');
    const proc = spawn('docker', args, { timeout: 15_000 });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code !== 0) reject(new Error(stderr.trim() || `exit ${code}`));
      else resolve(stdout.trim());
    });
    proc.stdin.write(value);
    proc.stdin.end();
  });
}

// â”€â”€ Docker Swarm secrets â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export const swarmSecretCreate = defineTool({
  name: 'swarm_secret_create',
  description: 'Create a Docker Swarm secret. Value is piped via stdin and never exposed in process arguments.',
  input: z.object({
    name: z.string().describe('Secret name (e.g. db_password, api_key)'),
    value: z.string().describe('Secret value â€” passed via stdin, not logged'),
    labels: z.array(z.string()).optional().describe('Labels (key=value) to attach to the secret'),
  }),
  async execute({ name, value, labels = [] }) {
    const id = await spawnDockerSecretCreate(name, value, labels);
    return JSON.stringify({ created: name, id: id.slice(0, 12) });
  },
});

export const swarmSecretList = defineTool({
  name: 'swarm_secret_list',
  description: 'List Docker Swarm secrets (names and metadata only â€” values are never accessible)',
  input: z.object({
    filter: z.string().optional().describe('Filter by name'),
  }),
  async execute({ filter }) {
    const args = ['secret', 'ls', '--format', '{{json .}}'];
    if (filter) args.push('--filter', `name=${filter}`);
    const out = await execDocker(args);
    if (!out) return 'No secrets found';
    const rows = out.split('\n').filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean);
    return JSON.stringify(rows);
  },
});

export const swarmSecretInspect = defineTool({
  name: 'swarm_secret_inspect',
  description: 'Inspect a Docker Swarm secret (metadata only â€” Docker never exposes secret values)',
  input: z.object({
    name: z.string().describe('Secret name or ID'),
  }),
  async execute({ name }) {
    const out = await execDocker(['secret', 'inspect', '--format', '{{json .}}', name]);
    const data = JSON.parse(out) as {
      ID: string;
      Spec: { Name: string; Labels: Record<string, string> };
      CreatedAt: string;
      UpdatedAt: string;
    };
    return JSON.stringify({
      id: data.ID,
      name: data.Spec.Name,
      labels: data.Spec.Labels,
      createdAt: data.CreatedAt,
      updatedAt: data.UpdatedAt,
    });
  },
});

export const swarmSecretRemove = defineTool({
  name: 'swarm_secret_remove',
  description: 'Remove one or more Docker Swarm secrets',
  input: z.object({
    names: z.array(z.string()).describe('Secret names or IDs to remove'),
  }),
  async execute({ names }) {
    await execDocker(['secret', 'rm', ...names]);
    return JSON.stringify({ removed: names });
  },
});

// â”€â”€ HashiCorp Vault KV â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

export const vaultKvRead = defineTool({
  name: 'vault_kv_read',
  description: 'Read a secret from HashiCorp Vault KV store. Requires VAULT_ADDR and VAULT_TOKEN env vars.',
  input: z.object({
    path: z.string().describe('KV path (e.g. secret/data/myapp/db)'),
    field: z.string().optional().describe('Return only this field from the secret data'),
  }),
  async execute({ path, field }) {
    const args = ['kv', 'get', '-format=json'];
    if (field) args.push(`-field=${field}`);
    args.push(path);
    const out = await execVault(args);
    if (field) return out; // raw field value
    const data = JSON.parse(out) as { data?: { data?: Record<string, unknown> } };
    return JSON.stringify(data.data?.data ?? data);
  },
});

export const vaultKvWrite = defineTool({
  name: 'vault_kv_write',
  description: 'Write a secret to HashiCorp Vault KV store. Requires VAULT_ADDR and VAULT_TOKEN env vars.',
  input: z.object({
    path: z.string().describe('KV path (e.g. secret/data/myapp/db)'),
    data: z.record(z.string()).describe('Key-value pairs to write (e.g. { "password": "s3cr3t" })'),
  }),
  async execute({ path, data }) {
    const pairs = Object.entries(data).map(([k, v]) => `${k}=${v}`);
    await execVault(['kv', 'put', path, ...pairs]);
    return JSON.stringify({ written: path, keys: Object.keys(data) });
  },
});

export const vaultKvList = defineTool({
  name: 'vault_kv_list',
  description: 'List secret paths under a Vault KV prefix. Requires VAULT_ADDR and VAULT_TOKEN env vars.',
  input: z.object({
    path: z.string().describe('KV path prefix to list (e.g. secret/data/myapp)'),
  }),
  async execute({ path }) {
    const out = await execVault(['kv', 'list', '-format=json', path]);
    const keys = JSON.parse(out) as string[];
    return JSON.stringify({ path, keys });
  },
});

export const vaultKvDelete = defineTool({
  name: 'vault_kv_delete',
  description: 'Delete a secret from HashiCorp Vault KV store. Requires VAULT_ADDR and VAULT_TOKEN env vars.',
  input: z.object({
    path: z.string().describe('KV path to delete'),
    versions: z.array(z.number()).optional().describe('Specific versions to delete (omit to delete latest)'),
  }),
  async execute({ path, versions }) {
    const args = ['kv', 'delete'];
    if (versions?.length) args.push('-versions', versions.join(','));
    args.push(path);
    await execVault(args);
    return JSON.stringify({ deleted: path, ...(versions ? { versions } : {}) });
  },
});

