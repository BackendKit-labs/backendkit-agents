import { execFile } from 'child_process';
import { defineTool, z } from '@backendkit-labs/agent-core';
import { loadConfig } from '../config';

function execRuntime(args: string[], timeoutMs?: number): Promise<string> {
  const config = loadConfig();
  const timeout = timeoutMs ?? config.defaultTimeout;
  const cmd = config.containerdRuntime;
  const nsArgs = cmd === 'nerdctl' ? ['--namespace', config.containerdNamespace, ...args] : args;

  return new Promise((resolve, reject) => {
    execFile(cmd, nsArgs, { timeout, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { reject(new Error(stderr.trim() || err.message)); return; }
      resolve(stdout.trim());
    });
  });
}

export const containerdRun = defineTool({
  name: 'containerd_run',
  description: 'Run a container via containerd (nerdctl)',
  input: z.object({
    image: z.string(),
    name: z.string().optional(),
    cmd: z.array(z.string()).optional(),
    env: z.array(z.string()).optional().describe('KEY=value pairs'),
    ports: z.array(z.string()).optional().describe('host:container port mappings'),
    volumes: z.array(z.string()).optional().describe('host:container volume bindings'),
    detach: z.boolean().optional().default(true),
    rm: z.boolean().optional().describe('Remove container on exit'),
    network: z.string().optional(),
  }),
  async execute({ image, name, cmd, env, ports, volumes, detach, rm, network }) {
    const args: string[] = ['run'];
    if (detach !== false) args.push('-d');
    if (rm) args.push('--rm');
    if (name) args.push('--name', name);
    if (env) env.forEach((e: string) => args.push('-e', e));
    if (ports) ports.forEach((p: string) => args.push('-p', p));
    if (volumes) volumes.forEach((v: string) => args.push('-v', v));
    if (network) args.push('--network', network);
    args.push(image);
    if (cmd) args.push(...cmd);
    const out = await execRuntime(args, 60_000);
    return `Container started: ${out.slice(0, 12)}`;
  },
});

export const containerdList = defineTool({
  name: 'containerd_list',
  description: 'List containers managed by containerd',
  input: z.object({
    all: z.boolean().optional().describe('Include stopped containers'),
  }),
  async execute({ all }) {
    const args = ['ps'];
    if (all) args.push('-a');
    return execRuntime(args);
  },
});

export const containerdStop = defineTool({
  name: 'containerd_stop',
  description: 'Stop a containerd container',
  input: z.object({
    container: z.string(),
    timeout: z.number().optional().default(10).describe('Seconds to wait before kill'),
  }),
  async execute({ container, timeout }) {
    await execRuntime(['stop', '-t', String(timeout ?? 10), container]);
    return `Stopped: ${container}`;
  },
});

export const containerdRemove = defineTool({
  name: 'containerd_remove',
  description: 'Remove a containerd container',
  input: z.object({
    container: z.string(),
    force: z.boolean().optional(),
  }),
  async execute({ container, force }) {
    const args = ['rm'];
    if (force) args.push('-f');
    args.push(container);
    await execRuntime(args);
    return `Removed: ${container}`;
  },
});

export const containerdLogs = defineTool({
  name: 'containerd_logs',
  description: 'Get logs from a containerd container',
  input: z.object({
    container: z.string(),
    tail: z.number().optional().default(100),
    timestamps: z.boolean().optional(),
  }),
  async execute({ container, tail, timestamps }) {
    const args = ['logs', '--tail', String(tail ?? 100)];
    if (timestamps) args.push('-t');
    args.push(container);
    return execRuntime(args, 15_000);
  },
});

export const containerdPull = defineTool({
  name: 'containerd_pull',
  description: 'Pull an image via containerd',
  input: z.object({
    image: z.string(),
    platform: z.string().optional(),
  }),
  async execute({ image, platform }) {
    const args = ['pull'];
    if (platform) args.push('--platform', platform);
    args.push(image);
    await execRuntime(args, 120_000);
    return `Pulled: ${image}`;
  },
});


