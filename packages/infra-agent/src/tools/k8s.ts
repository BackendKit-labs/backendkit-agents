import { execFile } from 'child_process';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { defineTool, z } from '@backendkit-labs/agent-core';
import { loadConfig } from '../config';

function kubectl(args: string[], timeoutMs?: number): Promise<string> {
  const config = loadConfig();
  const timeout = timeoutMs ?? config.defaultTimeout;
  const env = { ...process.env };
  if (config.kubeconfig) env.KUBECONFIG = config.kubeconfig;

  return new Promise((resolve, reject) => {
    execFile('kubectl', args, { timeout, maxBuffer: 10 * 1024 * 1024, env }, (err, stdout, stderr) => {
      if (err) { reject(new Error(stderr.trim() || err.message)); return; }
      resolve(stdout.trim());
    });
  });
}

export const k8sApply = defineTool({
  name: 'k8s_apply',
  description: 'Apply a Kubernetes manifest (YAML string or file path)',
  input: z.object({
    manifest: z.string().describe('YAML manifest content or absolute file path'),
    namespace: z.string().optional().describe('Target namespace (overrides manifest)'),
    dryRun: z.boolean().optional().describe('Validate without applying'),
  }),
  async execute({ manifest, namespace, dryRun }) {
    const isFile = !manifest.includes('\n') && !manifest.includes(':') && manifest.length < 300;
    let args: string[];

    if (isFile) {
      args = ['apply', '-f', manifest];
    } else {
      const tmpFile = join(tmpdir(), `k8s-${randomUUID()}.yaml`);
      writeFileSync(tmpFile, manifest, 'utf-8');
      args = ['apply', '-f', tmpFile];
      try {
        if (namespace) args.push('-n', namespace);
        if (dryRun) args.push('--dry-run=client');
        const out = await kubectl(args, 60_000);
        return out;
      } finally {
        try { unlinkSync(tmpFile); } catch {}
      }
    }

    if (namespace) args.push('-n', namespace);
    if (dryRun) args.push('--dry-run=client');
    return kubectl(args, 60_000);
  },
});

export const k8sGet = defineTool({
  name: 'k8s_get',
  description: 'Get Kubernetes resources (pods, deployments, services, etc.)',
  input: z.object({
    resource: z.string().describe('Resource type (pod, deployment, service, ingress, configmap, secret, node, ...)'),
    name: z.string().optional().describe('Specific resource name'),
    namespace: z.string().optional().describe('Namespace (default: from config)'),
    allNamespaces: z.boolean().optional().describe('Search across all namespaces'),
    output: z.enum(['wide', 'yaml', 'json', 'name']).optional().describe('Output format'),
    selector: z.string().optional().describe('Label selector (e.g. app=nginx)'),
  }),
  async execute({ resource, name, namespace, allNamespaces, output, selector }) {
    const config = loadConfig();
    const args = ['get', resource];
    if (name) args.push(name);
    if (allNamespaces) {
      args.push('-A');
    } else {
      args.push('-n', namespace ?? config.k8sNamespace);
    }
    if (output) args.push('-o', output);
    if (selector) args.push('-l', selector);
    return kubectl(args);
  },
});

export const k8sDescribe = defineTool({
  name: 'k8s_describe',
  description: 'Describe a Kubernetes resource in detail',
  input: z.object({
    resource: z.string().describe('Resource type'),
    name: z.string().describe('Resource name'),
    namespace: z.string().optional(),
  }),
  async execute({ resource, name, namespace }) {
    const config = loadConfig();
    return kubectl(['describe', resource, name, '-n', namespace ?? config.k8sNamespace]);
  },
});

export const k8sLogs = defineTool({
  name: 'k8s_logs',
  description: 'Get logs from a Kubernetes pod',
  input: z.object({
    pod: z.string().describe('Pod name or label selector (prefix with l: for label)'),
    namespace: z.string().optional(),
    container: z.string().optional().describe('Container name (for multi-container pods)'),
    tail: z.number().int().optional().default(100),
    previous: z.boolean().optional().describe('Get logs from previous container instance'),
    since: z.string().optional().describe('Time duration (e.g. 5m, 1h)'),
  }),
  async execute({ pod, namespace, container, tail, previous, since }) {
    const config = loadConfig();
    const args = ['logs'];
    if (pod.startsWith('l:')) {
      args.push('-l', pod.slice(2));
    } else {
      args.push(pod);
    }
    args.push('-n', namespace ?? config.k8sNamespace);
    args.push('--tail', String(tail ?? 100));
    if (container) args.push('-c', container);
    if (previous) args.push('-p');
    if (since) args.push('--since', since);
    return kubectl(args, 15_000);
  },
});

export const k8sExec = defineTool({
  name: 'k8s_exec',
  description: 'Execute a command inside a Kubernetes pod',
  input: z.object({
    pod: z.string(),
    cmd: z.array(z.string()).describe('Command and arguments'),
    namespace: z.string().optional(),
    container: z.string().optional(),
  }),
  async execute({ pod, cmd, namespace, container }) {
    const config = loadConfig();
    const args = ['exec', pod, '-n', namespace ?? config.k8sNamespace];
    if (container) args.push('-c', container);
    args.push('--', ...cmd);
    return kubectl(args, 30_000);
  },
});

export const k8sDelete = defineTool({
  name: 'k8s_delete',
  description: 'Delete a Kubernetes resource',
  input: z.object({
    resource: z.string().describe('Resource type'),
    name: z.string().describe('Resource name'),
    namespace: z.string().optional(),
    force: z.boolean().optional().describe('Force deletion (grace period 0)'),
  }),
  async execute({ resource, name, namespace, force }) {
    const config = loadConfig();
    const args = ['delete', resource, name, '-n', namespace ?? config.k8sNamespace];
    if (force) args.push('--grace-period=0', '--force');
    return kubectl(args);
  },
});


