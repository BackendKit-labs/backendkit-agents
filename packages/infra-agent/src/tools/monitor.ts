import { execFile } from 'child_process';
import Docker from 'dockerode';
import { defineTool, z } from '@backendkit-labs/agent-core';
import { getClient } from '../docker/client';
import { ContainerNotFoundError } from '../errors';

async function findContainer(idOrName: string): Promise<Docker.Container> {
  const docker = getClient();
  const containers = await docker.listContainers({ all: true });
  const match = containers.find(c =>
    c.Id.startsWith(idOrName) ||
    c.Names.some(n => n === `/${idOrName}` || n === idOrName),
  );
  if (!match) throw new ContainerNotFoundError(idOrName);
  return docker.getContainer(match.Id);
}

interface DockerStats {
  cpu_stats: {
    cpu_usage: { total_usage: number; percpu_usage?: number[] };
    system_cpu_usage?: number;
    online_cpus?: number;
  };
  precpu_stats: {
    cpu_usage: { total_usage: number };
    system_cpu_usage?: number;
  };
  memory_stats: {
    usage?: number;
    limit?: number;
    stats?: { cache?: number };
  };
  networks?: Record<string, { rx_bytes?: number; tx_bytes?: number }>;
  blkio_stats?: {
    io_service_bytes_recursive?: Array<{ op: string; value: number }>;
  };
}

async function readStats(container: Docker.Container): Promise<DockerStats> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const raw = await (container as any).stats({ stream: false });
  let json: string;
  if (Buffer.isBuffer(raw)) {
    json = raw.toString();
  } else if (raw && typeof raw.pipe === 'function') {
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      raw.on('data', (chunk: unknown) =>
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))));
      raw.on('end', resolve);
      raw.on('error', reject);
    });
    json = Buffer.concat(chunks).toString();
  } else {
    json = JSON.stringify(raw);
  }
  return JSON.parse(json) as DockerStats;
}

function formatStats(name: string, raw: DockerStats) {
  const cpuDelta = raw.cpu_stats.cpu_usage.total_usage - raw.precpu_stats.cpu_usage.total_usage;
  const sysDelta = (raw.cpu_stats.system_cpu_usage ?? 0) - (raw.precpu_stats.system_cpu_usage ?? 0);
  const cpus = raw.cpu_stats.online_cpus ?? raw.cpu_stats.cpu_usage.percpu_usage?.length ?? 1;
  const cpuPercent = sysDelta > 0 && cpuDelta >= 0
    ? parseFloat(((cpuDelta / sysDelta) * cpus * 100).toFixed(2))
    : 0;

  const cache = raw.memory_stats.stats?.cache ?? 0;
  const memUsage = (raw.memory_stats.usage ?? 0) - cache;
  const memLimit = raw.memory_stats.limit ?? 0;
  const memPercent = memLimit > 0 ? parseFloat(((memUsage / memLimit) * 100).toFixed(2)) : 0;

  let rxBytes = 0, txBytes = 0;
  for (const iface of Object.values(raw.networks ?? {})) {
    rxBytes += iface.rx_bytes ?? 0;
    txBytes += iface.tx_bytes ?? 0;
  }

  let readBytes = 0, writeBytes = 0;
  for (const entry of raw.blkio_stats?.io_service_bytes_recursive ?? []) {
    if (entry.op === 'Read') readBytes += entry.value;
    if (entry.op === 'Write') writeBytes += entry.value;
  }

  const mb = (b: number) => parseFloat((b / 1024 / 1024).toFixed(2));
  return {
    name,
    cpu: { percent: cpuPercent },
    memory: { usageMB: mb(memUsage), limitMB: mb(memLimit), percent: memPercent },
    network: { rxMB: mb(rxBytes), txMB: mb(txBytes) },
    blockIO: { readMB: mb(readBytes), writeMB: mb(writeBytes) },
  };
}

export const containerStats = defineTool({
  name: 'container_stats',
  description: 'Get CPU, memory, network I/O, and block I/O stats. Omit container to get stats for all running containers.',
  input: z.object({
    container: z.string().optional().describe('Container ID or name. Omit for all running containers.'),
  }),
  async execute({ container }) {
    const docker = getClient();

    if (container) {
      const c = await findContainer(container);
      const info = await c.inspect();
      const stats = await readStats(c);
      return JSON.stringify(formatStats(info.Name.replace(/^\//, ''), stats));
    }

    const list = await docker.listContainers({ all: false });
    if (list.length === 0) return 'No running containers';

    const results = await Promise.all(
      list.map(async (item) => {
        const name = item.Names[0]?.replace(/^\//, '') ?? item.Id.slice(0, 12);
        try {
          const c = docker.getContainer(item.Id);
          const stats = await readStats(c);
          return formatStats(name, stats);
        } catch {
          return { name, error: 'stats unavailable' };
        }
      }),
    );
    return JSON.stringify(results);
  },
});

export const containerTop = defineTool({
  name: 'container_top',
  description: 'List processes running inside a container (equivalent to docker top)',
  input: z.object({
    container: z.string().describe('Container ID or name'),
    psArgs: z.string().optional().describe('ps arguments (default: "aux")'),
  }),
  async execute({ container, psArgs }) {
    const c = await findContainer(container);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (c as any).top({ ps_args: psArgs ?? 'aux' }) as {
      Titles: string[];
      Processes: string[][];
    };
    const header = result.Titles.join('\t');
    const rows = (result.Processes ?? []).map((p: string[]) => p.join('\t'));
    return [header, ...rows].join('\n');
  },
});

export const containerHealth = defineTool({
  name: 'container_health',
  description: 'Get the health check status and last check results for a container',
  input: z.object({
    container: z.string().describe('Container ID or name'),
  }),
  async execute({ container }) {
    const c = await findContainer(container);
    const info = await c.inspect();
    const state = info.State as Record<string, unknown>;
    const health = state.Health as {
      Status: string;
      FailingStreak: number;
      Log: Array<{ Start: string; End: string; ExitCode: number; Output: string }>;
    } | null | undefined;

    if (!health) {
      return JSON.stringify({
        name: info.Name.replace(/^\//, ''),
        status: info.State.Status,
        health: 'no healthcheck configured',
      });
    }

    return JSON.stringify({
      name: info.Name.replace(/^\//, ''),
      status: info.State.Status,
      health: {
        status: health.Status,
        failingStreak: health.FailingStreak,
        log: (health.Log ?? []).slice(-5).map(e => ({
          exitCode: e.ExitCode,
          output: e.Output?.trim().slice(0, 200),
          start: e.Start,
        })),
      },
    });
  },
});

export const eventsTail = defineTool({
  name: 'events_tail',
  description: 'Fetch recent Docker events (container start/stop/die, image pull, volume create, etc.)',
  input: z.object({
    since: z.number().optional().describe('How many minutes back to fetch (default: 10)'),
    filter: z.string().optional().describe('Event type filter: container, image, network, volume'),
    limit: z.number().optional().describe('Max events to return (default: 50)'),
  }),
  async execute({ since = 10, filter, limit = 50 }) {
    const nowSec = Math.floor(Date.now() / 1000);
    const sinceSec = nowSec - since * 60;

    const args = [
      'events',
      '--since', String(sinceSec),
      '--until', String(nowSec),
      '--format', '{{json .}}',
    ];
    if (filter) args.push('--filter', `type=${filter}`);

    const output = await new Promise<string>((resolve, reject) => {
      execFile('docker', args, { maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err && !stdout) { reject(new Error(stderr.trim() || err.message)); return; }
        resolve(stdout.trim());
      });
    });

    if (!output) return `No Docker events in the last ${since} minutes`;

    const events = output.split('\n')
      .filter(Boolean)
      .map(line => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean)
      .slice(-limit);

    return JSON.stringify(events);
  },
});

