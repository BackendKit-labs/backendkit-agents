import { execFile } from 'child_process';
import type { ToolDefinition, ExecutionContext } from '@backendkit-labs/agent-core';
import { getClient } from '../docker/client';

export const systemInfo: ToolDefinition = {
  name: 'system_info',
  description: 'Get Docker system information (version, containers, images, etc.)',
  parameters: {
    type: 'object',
    properties: {},
  },
  async execute(_args: unknown, _ctx: ExecutionContext): Promise<string> {
    const docker = getClient();
    const info = await docker.info();
    return JSON.stringify({
      id: info.ID,
      name: info.Name,
      serverVersion: info.ServerVersion,
      operatingSystem: info.OperatingSystem,
      osVersion: info.OSVersion,
      kernelVersion: info.KernelVersion,
      architecture: info.Architecture,
      cpus: info.NCPU,
      memory: info.MemTotal,
      containers: info.Containers,
      running: info.ContainersRunning,
      paused: info.ContainersPaused,
      stopped: info.ContainersStopped,
      images: info.Images,
      storageDriver: info.Driver,
      dockerRootDir: info.DockerRootDir,
      httpProxy: info.HttpProxy,
      httpsProxy: info.HttpsProxy,
      noProxy: info.NoProxy,
      labels: info.Labels,
    });
  },
};

export const systemPrune: ToolDefinition = {
  name: 'system_prune',
  description: 'Remove unused Docker data (containers, images, volumes, networks)',
  parameters: {
    type: 'object',
    properties: {
      all: { type: 'boolean', description: 'Remove all unused images, not just dangling' },
      volumes: { type: 'boolean', description: 'Prune volumes as well' },
    },
  },
  async execute(args: unknown, _ctx: ExecutionContext): Promise<string> {
    const { all, volumes } = args as { all?: boolean; volumes?: boolean };

    return new Promise((resolve, reject) => {
      const pruneArgs = ['system', 'prune', '-f'];
      if (all) pruneArgs.push('--all');
      if (volumes) pruneArgs.push('--volumes');

      execFile('docker', pruneArgs, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`Prune failed: ${stderr.trim() || err.message}`));
          return;
        }
        resolve(stdout.trim());
      });
    });
  },
};
