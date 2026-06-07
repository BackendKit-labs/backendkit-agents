import { execFile } from 'child_process';
import { defineTool, z } from '@backendkit-labs/agent-core';
import { getClient } from '../docker/client';
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

export const swarmServiceCreate = defineTool({
  name: 'swarm_service_create',
  description: 'Create a Docker Swarm service',
  input: z.object({
    name: z.string().describe('Service name'),
    image: z.string().describe('Docker image'),
    replicas: z.number().int().min(1).optional().default(1),
    ports: z.array(z.string()).optional().describe('Port mappings (e.g. 8080:80)'),
    env: z.array(z.string()).optional().describe('Environment variables (KEY=value)'),
    networks: z.array(z.string()).optional().describe('Networks to attach'),
    mountVolume: z.string().optional().describe('Volume mount (source:target)'),
    constraint: z.array(z.string()).optional().describe('Placement constraints'),
    restart: z.enum(['any', 'on-failure', 'none']).optional().default('any'),
  }),
  async execute({ name, image, replicas, ports, env, networks, mountVolume, constraint, restart }) {
    const args = ['service', 'create', '--name', name, '--replicas', String(replicas ?? 1)];
    if (ports) ports.forEach((p: string) => args.push('-p', p));
    if (env) env.forEach((e: string) => args.push('-e', e));
    if (networks) networks.forEach((n: string) => args.push('--network', n));
    if (mountVolume) args.push('--mount', `type=volume,source=${mountVolume}`);
    if (constraint) constraint.forEach((c: string) => args.push('--constraint', c));
    if (restart) args.push('--restart-condition', restart);
    args.push(image);
    const id = await execDocker(args);
    return `Created service "${name}" (${id.slice(0, 12)}) â€” replicas: ${replicas ?? 1}`;
  },
});

export const swarmServiceList = defineTool({
  name: 'swarm_service_list',
  description: 'List Docker Swarm services',
  input: z.object({
    filter: z.string().optional().describe('Filter by service name'),
  }),
  async execute({ filter }) {
    const args = ['service', 'ls', '--format', '{{.Name}}\t{{.Mode}}\t{{.Replicas}}\t{{.Image}}'];
    if (filter) args.push('--filter', `name=${filter}`);
    const out = await execDocker(args);
    return out || 'No services running';
  },
});

export const swarmServiceInspect = defineTool({
  name: 'swarm_service_inspect',
  description: 'Inspect a Docker Swarm service',
  input: z.object({
    service: z.string().describe('Service name or ID'),
  }),
  async execute({ service }) {
    const out = await execDocker(['service', 'inspect', '--pretty', service]);
    return out;
  },
});

export const swarmServiceLogs = defineTool({
  name: 'swarm_service_logs',
  description: 'Get logs from a Docker Swarm service',
  input: z.object({
    service: z.string().describe('Service name or ID'),
    tail: z.number().int().optional().default(100),
    timestamps: z.boolean().optional(),
  }),
  async execute({ service, tail, timestamps }) {
    const args = ['service', 'logs', '--tail', String(tail ?? 100)];
    if (timestamps) args.push('-t');
    args.push(service);
    return execDocker(args, 15_000);
  },
});

export const swarmServiceUpdate = defineTool({
  name: 'swarm_service_update',
  description: 'Update a Docker Swarm service (scale, image, env)',
  input: z.object({
    service: z.string().describe('Service name'),
    replicas: z.number().int().optional().describe('New replica count'),
    image: z.string().optional().describe('New image'),
    envAdd: z.array(z.string()).optional().describe('Add/update env vars'),
    envRemove: z.array(z.string()).optional().describe('Remove env vars'),
  }),
  async execute({ service, replicas, image, envAdd, envRemove }) {
    const args = ['service', 'update'];
    if (replicas !== undefined) args.push('--replicas', String(replicas));
    if (image) args.push('--image', image);
    if (envAdd) envAdd.forEach((e: string) => args.push('--env-add', e));
    if (envRemove) envRemove.forEach((e: string) => args.push('--env-rm', e));
    args.push(service);
    await execDocker(args);
    return `Updated service "${service}"`;
  },
});

export const swarmServiceRemove = defineTool({
  name: 'swarm_service_remove',
  description: 'Remove a Docker Swarm service',
  input: z.object({
    service: z.string().describe('Service name or ID'),
  }),
  async execute({ service }) {
    await execDocker(['service', 'rm', service]);
    return `Removed service: ${service}`;
  },
});

export const swarmStackDeploy = defineTool({
  name: 'swarm_stack_deploy',
  description: 'Deploy or update a Docker Swarm stack from a compose file',
  input: z.object({
    stack: z.string().describe('Stack name'),
    composeFile: z.string().describe('Path to docker-compose file'),
    envFile: z.string().optional().describe('Path to env file'),
  }),
  async execute({ stack, composeFile, envFile }) {
    const args = ['stack', 'deploy', '-c', composeFile];
    if (envFile) args.push('--env-file', envFile);
    args.push(stack);
    const out = await execDocker(args, 120_000);
    return out || `Stack "${stack}" deployed`;
  },
});

export const swarmStackList = defineTool({
  name: 'swarm_stack_list',
  description: 'List Docker Swarm stacks',
  input: z.object({}),
  async execute() {
    const out = await execDocker(['stack', 'ls']);
    return out || 'No stacks deployed';
  },
});

export const swarmStackRemove = defineTool({
  name: 'swarm_stack_remove',
  description: 'Remove a Docker Swarm stack and all its services',
  input: z.object({
    stack: z.string().describe('Stack name'),
  }),
  async execute({ stack }) {
    await execDocker(['stack', 'rm', stack]);
    return `Removed stack: ${stack}`;
  },
});

export const swarmNodeList = defineTool({
  name: 'swarm_node_list',
  description: 'List Docker Swarm nodes',
  input: z.object({}),
  async execute() {
    const docker = getClient();
    const nodes = await docker.listNodes();
    if (nodes.length === 0) return 'No swarm nodes (not in swarm mode?)';
    return nodes.map(n => {
      const spec = n.Spec ?? {};
      const status = n.Status ?? {};
      return `${(spec.Name ?? n.ID?.slice(0, 12) ?? '').padEnd(20)} ${(spec.Role ?? '').padEnd(8)} ${(status.State ?? '').padEnd(10)} ${status.Addr ?? ''}`;
    }).join('\n');
  },
});


