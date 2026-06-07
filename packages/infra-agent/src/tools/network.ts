import { execFile } from 'child_process';
import { defineTool, z } from '@backendkit-labs/agent-core';
import { getClient } from '../docker/client';
import { loadConfig } from '../config';

function execDocker(args: string[], timeoutMs?: number): Promise<string> {
  const timeout = timeoutMs ?? loadConfig().defaultTimeout;
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout, maxBuffer: 2 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { reject(new Error(stderr.trim() || err.message)); return; }
      resolve(stdout.trim());
    });
  });
}

export const networkCreate = defineTool({
  name: 'network_create',
  description: 'Create a Docker network',
  input: z.object({
    name: z.string().describe('Network name'),
    driver: z.enum(['bridge', 'host', 'overlay', 'macvlan', 'none']).optional().default('bridge'),
    subnet: z.string().optional().describe('Subnet in CIDR format (e.g. 172.20.0.0/16)'),
    gateway: z.string().optional().describe('Gateway IP'),
    internal: z.boolean().optional().describe('Restrict external access'),
    attachable: z.boolean().optional().describe('Allow manual container attachment (overlay)'),
    labels: z.record(z.string()).optional(),
  }),
  async execute({ name, driver, subnet, gateway, internal, attachable, labels }) {
    const docker = getClient();
    const opts: Record<string, unknown> = { Name: name, Driver: driver ?? 'bridge' };
    if (internal) opts.Internal = true;
    if (attachable) opts.Attachable = true;
    if (labels) opts.Labels = labels;
    if (subnet || gateway) {
      opts.IPAM = {
        Config: [{ Subnet: subnet, Gateway: gateway }].filter(c => c.Subnet || c.Gateway),
      };
    }
    const net = await docker.createNetwork(opts as unknown as Parameters<typeof docker.createNetwork>[0]);
    const info = await net.inspect();
    return JSON.stringify({ id: info.Id.slice(0, 12), name: info.Name, driver: info.Driver, scope: info.Scope });
  },
});

export const networkList = defineTool({
  name: 'network_list',
  description: 'List Docker networks',
  input: z.object({
    filter: z.string().optional().describe('Filter by name'),
  }),
  async execute({ filter }) {
    const docker = getClient();
    const networks = await docker.listNetworks();
    const filtered = filter ? networks.filter(n => n.Name.includes(filter)) : networks;
    if (filtered.length === 0) return 'No networks found';
    return filtered.map(n =>
      `${n.Name.padEnd(25)} ${n.Driver.padEnd(10)} ${n.Scope.padEnd(8)} ${n.Id.slice(0, 12)}`
    ).join('\n');
  },
});

export const networkInspect = defineTool({
  name: 'network_inspect',
  description: 'Inspect a Docker network',
  input: z.object({
    network: z.string().describe('Network name or ID'),
  }),
  async execute({ network }) {
    const docker = getClient();
    const net = docker.getNetwork(network);
    const info = await net.inspect();
    return JSON.stringify({
      id: info.Id.slice(0, 12),
      name: info.Name,
      driver: info.Driver,
      scope: info.Scope,
      ipam: info.IPAM,
      containers: Object.keys(info.Containers ?? {}).length,
      labels: info.Labels,
    }, null, 2);
  },
});

export const networkRemove = defineTool({
  name: 'network_remove',
  description: 'Remove a Docker network',
  input: z.object({
    network: z.string().describe('Network name or ID'),
  }),
  async execute({ network }) {
    const docker = getClient();
    const net = docker.getNetwork(network);
    await net.remove();
    return `Removed network: ${network}`;
  },
});

export const networkConnect = defineTool({
  name: 'network_connect',
  description: 'Connect a container to a network',
  input: z.object({
    network: z.string().describe('Network name or ID'),
    container: z.string().describe('Container name or ID'),
    alias: z.string().optional().describe('Network alias for the container'),
  }),
  async execute({ network, container, alias }) {
    const docker = getClient();
    const net = docker.getNetwork(network);
    const opts: Record<string, unknown> = { Container: container };
    if (alias) opts.EndpointConfig = { Aliases: [alias] };
    await net.connect(opts as Parameters<typeof net.connect>[0]);
    return `Connected container "${container}" to network "${network}"`;
  },
});

export const networkDisconnect = defineTool({
  name: 'network_disconnect',
  description: 'Disconnect a container from a Docker network',
  input: z.object({
    network: z.string().describe('Network name or ID'),
    container: z.string().describe('Container name or ID'),
    force: z.boolean().optional().describe('Force disconnection even if the container is running'),
  }),
  async execute({ network, container, force }) {
    const docker = getClient();
    const net = docker.getNetwork(network);
    await net.disconnect({ Container: container, Force: force ?? false } as Parameters<typeof net.disconnect>[0]);
    return `Disconnected container "${container}" from network "${network}"`;
  },
});

export const networkPrune = defineTool({
  name: 'network_prune',
  description: 'Remove all unused Docker networks (not referenced by any container)',
  input: z.object({
    filter: z.string().optional().describe('Filter by label (e.g. "env=staging")'),
  }),
  async execute({ filter }) {
    const args = ['network', 'prune', '-f'];
    if (filter) args.push('--filter', `label=${filter}`);
    const out = await execDocker(args);
    return out || 'No unused networks to remove';
  },
});

export const networkDiagnose = defineTool({
  name: 'network_diagnose',
  description: 'Test network connectivity from inside a container to a target host or URL',
  input: z.object({
    fromContainer: z.string().describe('Source container name or ID'),
    target: z.string().describe('Target hostname, IP, or URL'),
    method: z.enum(['ping', 'curl', 'nc']).optional().describe('Test method (default: ping)'),
    port: z.number().optional().describe('Port to check — required for nc, optional for curl'),
    count: z.number().optional().describe('Number of ping packets (default: 3)'),
  }),
  async execute({ fromContainer, target, method = 'ping', port, count = 3 }) {
    let cmd: string[];

    switch (method) {
      case 'curl': {
        const url = target.startsWith('http') ? target : `http://${target}${port ? `:${port}` : ''}`;
        cmd = ['exec', fromContainer, 'curl', '-s', '-o', '/dev/null', '-w', '%{http_code} %{time_total}s', '--connect-timeout', '5', url];
        break;
      }
      case 'nc': {
        if (!port) return 'Error: port is required for the nc method';
        cmd = ['exec', fromContainer, 'nc', '-zv', '-w', '3', target, String(port)];
        break;
      }
      default: {
        cmd = ['exec', fromContainer, 'ping', '-c', String(count), '-W', '2', target];
      }
    }

    const out = await execDocker(cmd, 20_000);
    return out;
  },
});

export const networkDnsLookup = defineTool({
  name: 'network_dns_lookup',
  description: 'Resolve a hostname from inside a container to verify DNS and service discovery',
  input: z.object({
    container: z.string().describe('Container to run the lookup from'),
    hostname: z.string().describe('Hostname or Docker service name to resolve'),
  }),
  async execute({ container, hostname }) {
    // Try nslookup first, fall back to getent, then show resolv.conf for context
    const attempts: Array<{ tool: string; args: string[] }> = [
      { tool: 'nslookup', args: ['exec', container, 'nslookup', hostname] },
      { tool: 'getent',   args: ['exec', container, 'getent', 'hosts', hostname] },
    ];

    for (const attempt of attempts) {
      try {
        const out = await execDocker(attempt.args, 10_000);
        return JSON.stringify({ tool: attempt.tool, hostname, result: out });
      } catch {
        // try next
      }
    }

    // Both failed — return DNS config for debugging
    try {
      const resolvConf = await execDocker(['exec', container, 'cat', '/etc/resolv.conf'], 5_000);
      return JSON.stringify({
        error: `Could not resolve "${hostname}" — neither nslookup nor getent are available in this container`,
        dnsConfig: resolvConf,
      });
    } catch {
      return `Could not resolve "${hostname}" and failed to read DNS config from container "${container}"`;
    }
  },
});


