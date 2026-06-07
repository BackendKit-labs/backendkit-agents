import Docker from 'dockerode';
import { DockerConnectionError, DockerPermissionError } from '../errors';
import { loadConfig } from '../config';

let client: Docker | null = null;

export function getClient(): Docker {
  if (client) return client;

  const config = loadConfig();

  const opts: Docker.DockerOptions = { timeout: config.defaultTimeout };

  // DOCKER_HOST from environment (set by user or docker context activation)
  const dockerHost = process.env.DOCKER_HOST ?? config.dockerHost ?? null;

  if (dockerHost) {
    // npipe:////./pipe/... → socketPath; tcp://host:port → host+port
    if (dockerHost.startsWith('npipe://')) {
      opts.socketPath = dockerHost.replace('npipe://', '');
    } else if (dockerHost.startsWith('tcp://') || dockerHost.startsWith('http://')) {
      const url = new URL(dockerHost.replace('tcp://', 'http://'));
      opts.host = url.hostname;
      opts.port = Number(url.port) || 2375;
    } else {
      opts.socketPath = dockerHost;
    }
  } else if (config.dockerSocketPath) {
    opts.socketPath = config.dockerSocketPath;
  } else if (config.platform === 'win32') {
    // Docker Desktop Linux context uses dockerDesktopLinuxEngine pipe
    opts.socketPath = '//./pipe/dockerDesktopLinuxEngine';
  } else {
    opts.socketPath = '/var/run/docker.sock';
  }

  try {
    client = new Docker(opts);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('EACCES') || msg.includes('permission')) {
      throw new DockerPermissionError(msg);
    }
    throw new DockerConnectionError(msg);
  }

  return client;
}

export function resetClient(): void {
  client = null;
}
