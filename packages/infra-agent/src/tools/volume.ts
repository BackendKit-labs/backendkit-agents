import { defineTool, z } from '@backendkit-labs/agent-core';
import { getClient } from '../docker/client';

export const volumeCreate = defineTool({
  name: 'volume_create',
  description: 'Create a Docker volume',
  input: z.object({
    name: z.string().describe('Volume name'),
    driver: z.string().optional().default('local').describe('Volume driver'),
    driverOpts: z.record(z.string()).optional().describe('Driver-specific options'),
    labels: z.record(z.string()).optional(),
  }),
  async execute({ name, driver, driverOpts, labels }) {
    const docker = getClient();
    const vol = await docker.createVolume({
      Name: name,
      Driver: driver ?? 'local',
      DriverOpts: driverOpts,
      Labels: labels,
    });
    return JSON.stringify({ name: vol.Name, driver: vol.Driver, mountpoint: vol.Mountpoint });
  },
});

export const volumeList = defineTool({
  name: 'volume_list',
  description: 'List Docker volumes',
  input: z.object({
    filter: z.string().optional().describe('Filter by name'),
    dangling: z.boolean().optional().describe('Show only volumes not referenced by containers'),
  }),
  async execute({ filter, dangling }) {
    const docker = getClient();
    const filters: Record<string, string[]> = {};
    if (dangling) filters.dangling = ['true'];
    if (filter) filters.name = [filter];
    const result = await docker.listVolumes({ filters: Object.keys(filters).length ? filters : undefined });
    const vols = result.Volumes ?? [];
    if (vols.length === 0) return 'No volumes found';
    return vols.map(v =>
      `${v.Name.padEnd(30)} ${v.Driver.padEnd(10)} ${v.Mountpoint}`
    ).join('\n');
  },
});

export const volumeInspect = defineTool({
  name: 'volume_inspect',
  description: 'Inspect a Docker volume',
  input: z.object({
    volume: z.string().describe('Volume name'),
  }),
  async execute({ volume }) {
    const docker = getClient();
    const vol = docker.getVolume(volume);
    const info = await vol.inspect();
    return JSON.stringify({
      name: info.Name,
      driver: info.Driver,
      mountpoint: info.Mountpoint,
      labels: info.Labels,
      options: info.Options,
      scope: info.Scope,
    }, null, 2);
  },
});

export const volumeRemove = defineTool({
  name: 'volume_remove',
  description: 'Remove a Docker volume',
  input: z.object({
    volume: z.string().describe('Volume name'),
    force: z.boolean().optional().describe('Force removal even if in use'),
  }),
  async execute({ volume, force }) {
    const docker = getClient();
    const vol = docker.getVolume(volume);
    await vol.remove({ force: force ?? false });
    return `Removed volume: ${volume}`;
  },
});


