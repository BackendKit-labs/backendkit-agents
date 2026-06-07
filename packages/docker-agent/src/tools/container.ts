import stream from 'stream';
import type { ToolDefinition, ExecutionContext } from '@backendkit-labs/agent-core';
import { getClient } from '../docker/client';
import {
  ContainerNotFoundError,
  ContainerNotRunningError,
  ContainerCreateError,
  ContainerExecError,
  DockerTimeoutError,
} from '../errors';
import type { ContainerSpec, ExecResult } from '../docker/types';

async function findContainer(idOrName: string) {
  const docker = getClient();
  const containers = await docker.listContainers({ all: true });
  const match = containers.find(c =>
    c.Id.startsWith(idOrName) ||
    c.Names.some(n => n === `/${idOrName}` || n === idOrName),
  );
  if (!match) throw new ContainerNotFoundError(idOrName);
  return docker.getContainer(match.Id);
}

export const containerCreate: ToolDefinition = {
  name: 'container_create',
  description: 'Create and start a new Docker container',
  parameters: {
    type: 'object',
    properties: {
      image: { type: 'string', description: 'Docker image to use' },
      name: { type: 'string', description: 'Container name' },
      cmd: { type: 'array', items: { type: 'string' }, description: 'Command to run' },
      env: { type: 'array', items: { type: 'string' }, description: 'Environment variables (KEY=value)' },
      ports: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            hostPort: { type: 'number' },
            containerPort: { type: 'number' },
            protocol: { type: 'string', enum: ['tcp', 'udp'] },
          },
        },
      },
      volumes: { type: 'array', items: { type: 'string' }, description: 'Volume bindings (host:container)' },
      networkMode: { type: 'string' },
      workingDir: { type: 'string' },
      entrypoint: { type: 'array', items: { type: 'string' } },
      labels: { type: 'object', additionalProperties: { type: 'string' } },
      restartPolicy: { type: 'string', enum: ['no', 'always', 'on-failure', 'unless-stopped'] },
    },
    required: ['image'],
  },
  async execute(args: unknown, _ctx: ExecutionContext): Promise<string> {
    const spec = args as ContainerSpec;
    const docker = getClient();

    const createOpts: Record<string, unknown> = {
      Image: spec.image,
      Cmd: spec.cmd,
      Env: spec.env,
      WorkingDir: spec.workingDir,
      Entrypoint: spec.entrypoint,
      Labels: spec.labels,
    };

    if (spec.name) createOpts.name = spec.name;
    if (spec.networkMode) createOpts.HostConfig = { NetworkMode: spec.networkMode };
    if (spec.restartPolicy) {
      createOpts.HostConfig = {
        ...(createOpts.HostConfig as Record<string, unknown> || {}),
        RestartPolicy: { Name: spec.restartPolicy },
      };
    }
    if (spec.ports) {
      const exposedPorts: Record<string, object> = {};
      const portBindings: Record<string, Array<{ HostPort: string }>> = {};
      for (const p of spec.ports) {
        const key = `${p.containerPort}/${p.protocol}`;
        exposedPorts[key] = {};
        portBindings[key] = [{ HostPort: String(p.hostPort) }];
      }
      createOpts.ExposedPorts = exposedPorts;
      createOpts.HostConfig = {
        ...(createOpts.HostConfig as Record<string, unknown> || {}),
        PortBindings: portBindings,
      };
    }
    if (spec.volumes) {
      const binds = spec.volumes.map(v => {
        const [host, container] = v.split(':');
        return `${host}:${container}`;
      });
      createOpts.HostConfig = {
        ...(createOpts.HostConfig as Record<string, unknown> || {}),
        Binds: binds,
      };
    }

    let container;
    try {
      container = await docker.createContainer(createOpts);
    } catch (err) {
      throw new ContainerCreateError(
        err instanceof Error ? err.message : String(err),
        { image: spec.image },
      );
    }

    try {
      await container.start();
    } catch (err) {
      await container.remove({ force: true }).catch(() => {});
      throw new ContainerCreateError(
        `Container created but failed to start: ${err instanceof Error ? err.message : String(err)}`,
        { image: spec.image },
      );
    }

    const info = await container.inspect();
    return JSON.stringify({
      id: info.Id,
      name: info.Name.replace(/^\//, ''),
      image: info.Config.Image,
      status: info.State.Status,
      created: info.Created,
    });
  },
};

export const containerExec: ToolDefinition = {
  name: 'container_exec',
  description: 'Execute a command inside a running container',
  parameters: {
    type: 'object',
    properties: {
      container: { type: 'string', description: 'Container ID or name' },
      cmd: { type: 'array', items: { type: 'string' }, description: 'Command and arguments' },
      timeout: { type: 'number', description: 'Timeout in ms' },
    },
    required: ['container', 'cmd'],
  },
  async execute(args: unknown, _ctx: ExecutionContext): Promise<string> {
    const { container: idOrName, cmd, timeout } = args as {
      container: string;
      cmd: string[];
      timeout?: number;
    };
    const container = await findContainer(idOrName);
    const info = await container.inspect();
    if (info.State.Status !== 'running') {
      throw new ContainerNotRunningError(idOrName, info.State.Status);
    }

    const exec = await container.exec({
      Cmd: cmd,
      AttachStdout: true,
      AttachStderr: true,
    });

    const duplex = await exec.start({ Detach: false, Tty: false });
    const result = await new Promise<ExecResult>((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      const timeoutId = timeout
        ? setTimeout(() => reject(new DockerTimeoutError('container.exec', timeout)), timeout)
        : undefined;

      duplex.on('data', (chunk: Buffer) => {
        const raw = chunk.toString();
        const type = raw.charCodeAt(0);
        const data = raw.slice(8);
        if (type === 1) stdout += data;
        else if (type === 2) stderr += data;
        else stdout += data;
      });

      duplex.on('end', async () => {
        if (timeoutId) clearTimeout(timeoutId);
        try {
          const inspect = await exec.inspect();
          resolve({ exitCode: inspect.ExitCode ?? -1, stdout, stderr });
        } catch {
          resolve({ exitCode: -1, stdout, stderr });
        }
      });

      duplex.on('error', (err: Error) => {
        if (timeoutId) clearTimeout(timeoutId);
        reject(err);
      });
    });

    if (result.exitCode !== 0) {
      throw new ContainerExecError(idOrName, result.exitCode, result.stderr);
    }

    return JSON.stringify(result);
  },
};

export const containerStop: ToolDefinition = {
  name: 'container_stop',
  description: 'Stop a running container',
  parameters: {
    type: 'object',
    properties: {
      container: { type: 'string', description: 'Container ID or name' },
      timeout: { type: 'number', description: 'Seconds to wait before killing' },
    },
    required: ['container'],
  },
  async execute(args: unknown, _ctx: ExecutionContext): Promise<string> {
    const { container: idOrName, timeout } = args as {
      container: string;
      timeout?: number;
    };
    const container = await findContainer(idOrName);
    await container.stop({ t: timeout ?? 10 });
    const info = await container.inspect();
    return JSON.stringify({
      id: info.Id,
      status: info.State.Status,
    });
  },
};

export const containerRemove: ToolDefinition = {
  name: 'container_remove',
  description: 'Remove a container',
  parameters: {
    type: 'object',
    properties: {
      container: { type: 'string', description: 'Container ID or name' },
      force: { type: 'boolean', description: 'Force removal of running container' },
      removeVolumes: { type: 'boolean', description: 'Remove anonymous volumes' },
    },
    required: ['container'],
  },
  async execute(args: unknown, _ctx: ExecutionContext): Promise<string> {
    const { container: idOrName, force, removeVolumes } = args as {
      container: string;
      force?: boolean;
      removeVolumes?: boolean;
    };
    const container = await findContainer(idOrName);
    await container.remove({ force: !!force, v: !!removeVolumes });
    return JSON.stringify({ removed: idOrName });
  },
};

export const containerLogs: ToolDefinition = {
  name: 'container_logs',
  description: 'Fetch logs from a container',
  parameters: {
    type: 'object',
    properties: {
      container: { type: 'string', description: 'Container ID or name' },
      tail: { type: 'number', description: 'Number of lines to show from the end' },
      since: { type: 'string', description: 'Only return logs after this timestamp (Unix)' },
      stdout: { type: 'boolean', description: 'Include stdout' },
      stderr: { type: 'boolean', description: 'Include stderr' },
    },
    required: ['container'],
  },
  async execute(args: unknown, _ctx: ExecutionContext): Promise<string> {
    const { container: idOrName, tail, since, stdout, stderr } = args as {
      container: string;
      tail?: number;
      since?: string;
      stdout?: boolean;
      stderr?: boolean;
    };
    const container = await findContainer(idOrName);
    const opts: Record<string, unknown> = {
      follow: false,
      stdout: stdout !== false,
      stderr: stderr !== false,
    };
    if (tail !== undefined) opts.tail = tail;
    if (since !== undefined) opts.since = since;

    const buf = await container.logs(opts as Record<string, unknown>);
    const output = buf.toString();
    return output.trim();
  },
};

export const containerList: ToolDefinition = {
  name: 'container_list',
  description: 'List Docker containers (running by default, or all)',
  parameters: {
    type: 'object',
    properties: {
      all: { type: 'boolean', description: 'Include stopped containers (default: false)' },
      filter: { type: 'string', description: 'Filter by name or image' },
    },
  },
  async execute(args: unknown, _ctx: ExecutionContext): Promise<string> {
    const { all, filter } = (args ?? {}) as { all?: boolean; filter?: string };
    const docker = getClient();
    const filters: Record<string, string[]> = {};
    if (filter) filters.name = [filter];
    const containers = await docker.listContainers({
      all: all ?? false,
      filters: Object.keys(filters).length ? filters : undefined,
    });
    if (containers.length === 0) return all ? 'No containers found' : 'No running containers';
    return containers.map(c => {
      const name = c.Names[0]?.replace(/^\//, '') ?? c.Id.slice(0, 12);
      const ports = c.Ports.map(p => p.PublicPort ? `${p.PublicPort}:${p.PrivatePort}` : `${p.PrivatePort}`).join(', ');
      return `${name.padEnd(25)} ${c.Image.padEnd(30)} ${c.Status.padEnd(20)} ${ports}`;
    }).join('\n');
  },
};

export const containerInspect: ToolDefinition = {
  name: 'container_inspect',
  description: 'Inspect a container (detailed info)',
  parameters: {
    type: 'object',
    properties: {
      container: { type: 'string', description: 'Container ID or name' },
    },
    required: ['container'],
  },
  async execute(args: unknown, _ctx: ExecutionContext): Promise<string> {
    const { container: idOrName } = args as { container: string };
    const container = await findContainer(idOrName);
    const info = await container.inspect();
    return JSON.stringify({
      id: info.Id,
      name: info.Name.replace(/^\//, ''),
      image: info.Config.Image,
      created: info.Created,
      state: {
        status: info.State.Status,
        running: info.State.Running,
        exitCode: info.State.ExitCode,
        startedAt: info.State.StartedAt,
        finishedAt: info.State.FinishedAt,
      },
      config: {
        cmd: info.Config.Cmd,
        env: info.Config.Env,
        entrypoint: info.Config.Entrypoint,
        workingDir: info.Config.WorkingDir,
        labels: info.Config.Labels,
      },
      networkSettings: info.NetworkSettings,
      mounts: info.Mounts,
    });
  },
};
