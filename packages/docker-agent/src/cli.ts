import { loadConfig } from './config';
import { getClient, resetClient } from './docker/client';
import { containerCreate, containerExec, containerStop, containerRemove, containerLogs, containerInspect } from './tools/container';
import { systemInfo, systemPrune } from './tools/system';
import type { ExecutionContext } from '@backendkit-labs/agent-core';

const ctx: ExecutionContext = {
  agentId: 'docker-agent',
  sessionId: 'cli-session',
  memory: { get: () => undefined, set: () => {}, getAll: () => ({}) },
  askAgent: async () => '',
};

function printJSON(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0]?.toLowerCase();
  const params = args.slice(1);

  if (!command || command === 'help') {
    console.log(`
🐳 Docker Agent — CLI directo

Comandos:
  info                          Información del sistema Docker
  ps [all]                      Listar contenedores (all para todos)
  create <image> [name]         Crear y arrancar contenedor
  exec <container> <cmd...>     Ejecutar comando en contenedor
  stop <container>              Detener contenedor
  rm <container> [--force]      Eliminar contenedor
  logs <container> [tail]       Ver logs
  inspect <container>           Inspeccionar contenedor
  prune [--volumes]             Limpiar recursos no usados
  help                          Este mensaje
`);
    return;
  }

  try {
    switch (command) {
      case 'info': {
        const result = await systemInfo.execute({}, ctx);
        printJSON(JSON.parse(result));
        break;
      }
      case 'ps': {
        const docker = getClient();
        const all = params[0] === 'all';
        const containers = await docker.listContainers({ all });
        printJSON(containers.map(c => ({
          id: c.Id.slice(0, 12),
          name: c.Names.map((n: string) => n.replace(/^\//, '')),
          image: c.Image,
          state: c.State,
          status: c.Status,
          ports: c.Ports,
        })));
        break;
      }
      case 'create': {
        const image = params[0];
        if (!image) { console.error('Error: image required'); process.exit(1); }
        const result = await containerCreate.execute({
          image,
          name: params[1],
          cmd: ['sleep', 'infinity'],
        }, ctx);
        printJSON(JSON.parse(result));
        break;
      }
      case 'exec': {
        const container = params[0];
        const cmd = params.slice(1);
        if (!container || cmd.length === 0) { console.error('Error: container and cmd required'); process.exit(1); }
        const result = await containerExec.execute({ container, cmd }, ctx);
        printJSON(JSON.parse(result));
        break;
      }
      case 'stop': {
        const container = params[0];
        if (!container) { console.error('Error: container required'); process.exit(1); }
        const result = await containerStop.execute({ container }, ctx);
        printJSON(JSON.parse(result));
        break;
      }
      case 'rm': {
        const container = params[0];
        if (!container) { console.error('Error: container required'); process.exit(1); }
        const force = params.includes('--force');
        const result = await containerRemove.execute({ container, force }, ctx);
        printJSON(JSON.parse(result));
        break;
      }
      case 'logs': {
        const container = params[0];
        const tail = params[1] ? parseInt(params[1], 10) : 50;
        if (!container) { console.error('Error: container required'); process.exit(1); }
        const result = await containerLogs.execute({ container, tail }, ctx);
        console.log(result);
        break;
      }
      case 'inspect': {
        const container = params[0];
        if (!container) { console.error('Error: container required'); process.exit(1); }
        const result = await containerInspect.execute({ container }, ctx);
        printJSON(JSON.parse(result));
        break;
      }
      case 'prune': {
        const volumes = params.includes('--volumes');
        const result = await systemPrune.execute({ all: true, volumes }, ctx);
        console.log(result);
        break;
      }
      default:
        console.error(`Comando desconocido: ${command}. Usa 'help' para ver los comandos disponibles.`);
        process.exit(1);
    }
  } catch (err) {
    console.error('Error:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

main();
