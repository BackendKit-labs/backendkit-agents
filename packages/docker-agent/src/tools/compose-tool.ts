import { defineTool, z } from '@backendkit-labs/agent-core';
import { composeUp, composeDown, composeBuild, composeLogs, composePs } from '../docker/compose';

export const composeTool = {
  up: defineTool({
    name: 'compose_up',
    description: 'Start Docker Compose services (docker compose up)',
    input: z.object({
      composeFile: z.string().describe('Path to docker-compose.yml'),
      services: z.array(z.string()).optional().describe('Specific services to start (default: all)'),
      detach: z.boolean().optional().default(true).describe('Run in background'),
    }),
    async execute({ composeFile, services, detach }) {
      const out = await composeUp(composeFile, services, detach !== false);
      return out || 'Services started';
    },
  }),

  down: defineTool({
    name: 'compose_down',
    description: 'Stop and remove Docker Compose services (docker compose down)',
    input: z.object({
      composeFile: z.string().describe('Path to docker-compose.yml'),
      removeVolumes: z.boolean().optional().describe('Also remove named volumes'),
      services: z.array(z.string()).optional().describe('Specific services to stop'),
    }),
    async execute({ composeFile, removeVolumes, services }) {
      const out = await composeDown(composeFile, removeVolumes, services);
      return out || 'Services stopped';
    },
  }),

  build: defineTool({
    name: 'compose_build',
    description: 'Build Docker Compose service images',
    input: z.object({
      composeFile: z.string().describe('Path to docker-compose.yml'),
      services: z.array(z.string()).optional().describe('Specific services to build'),
    }),
    async execute({ composeFile, services }) {
      const out = await composeBuild(composeFile, services);
      return out || 'Build complete';
    },
  }),

  ps: defineTool({
    name: 'compose_ps',
    description: 'List Docker Compose service containers and their status',
    input: z.object({
      composeFile: z.string().describe('Path to docker-compose.yml'),
    }),
    async execute({ composeFile }) {
      const services = await composePs(composeFile);
      if (services.length === 0) return 'No services running';
      return services.map(s =>
        `${s.name.padEnd(25)} ${s.state.padEnd(10)} ${s.image}`
      ).join('\n');
    },
  }),

  logs: defineTool({
    name: 'compose_logs',
    description: 'Get logs from Docker Compose services',
    input: z.object({
      composeFile: z.string().describe('Path to docker-compose.yml'),
      services: z.array(z.string()).optional().describe('Specific services'),
      tail: z.number().optional().default(100),
    }),
    async execute({ composeFile, services, tail }) {
      return composeLogs(composeFile, services, tail ?? 100);
    },
  }),
};


