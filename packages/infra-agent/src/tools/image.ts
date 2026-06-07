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

export const imagePull = defineTool({
  name: 'image_pull',
  description: 'Pull a Docker image from a registry',
  input: z.object({
    image: z.string().describe('Image name (e.g. nginx:latest, postgres:16)'),
    platform: z.string().optional().describe('Target platform (e.g. linux/amd64)'),
  }),
  async execute({ image, platform }) {
    const args = ['pull', image];
    if (platform) args.push('--platform', platform);
    await execDocker(args, 120_000);
    return `Pulled image: ${image}`;
  },
});

export const imageBuild = defineTool({
  name: 'image_build',
  description: 'Build a Docker image from a Dockerfile',
  input: z.object({
    contextPath: z.string().describe('Build context directory path'),
    tag: z.string().optional().describe('Image tag (e.g. myapp:latest)'),
    dockerfile: z.string().optional().describe('Dockerfile path relative to context'),
    buildArgs: z.record(z.string()).optional().describe('Build arguments (KEY=value)'),
    noCache: z.boolean().optional().describe('Disable build cache'),
  }),
  async execute({ contextPath, tag, dockerfile, buildArgs, noCache }) {
    const args = ['build', contextPath];
    if (tag) args.push('-t', tag);
    if (dockerfile) args.push('-f', dockerfile);
    if (noCache) args.push('--no-cache');
    if (buildArgs) {
      for (const [k, v] of Object.entries(buildArgs)) {
        args.push('--build-arg', `${k}=${v}`);
      }
    }
    await execDocker(args, 300_000);
    return `Built image${tag ? `: ${tag}` : ''} from ${contextPath}`;
  },
});

export const imageList = defineTool({
  name: 'image_list',
  description: 'List Docker images available locally',
  input: z.object({
    filter: z.string().optional().describe('Filter by name/tag'),
    dangling: z.boolean().optional().describe('Show only dangling (untagged) images'),
  }),
  async execute({ filter, dangling }) {
    const docker = getClient();
    const filters: Record<string, string[]> = {};
    if (dangling) filters.dangling = ['true'];
    if (filter) filters.reference = [filter];
    const images = await docker.listImages({ filters: Object.keys(filters).length ? filters : undefined });
    if (images.length === 0) return 'No images found';
    return images.map(img => {
      const tags = img.RepoTags?.join(', ') ?? '<none>';
      const size = (img.Size / 1024 / 1024).toFixed(1);
      return `${tags}  ID: ${img.Id.slice(7, 19)}  Size: ${size}MB`;
    }).join('\n');
  },
});

export const imageRemove = defineTool({
  name: 'image_remove',
  description: 'Remove a Docker image',
  input: z.object({
    image: z.string().describe('Image name or ID'),
    force: z.boolean().optional().describe('Force removal even if used by stopped containers'),
  }),
  async execute({ image, force }) {
    const docker = getClient();
    const img = docker.getImage(image);
    await img.remove({ force: force ?? false });
    return `Removed image: ${image}`;
  },
});

export const imageTag = defineTool({
  name: 'image_tag',
  description: 'Tag a Docker image with a new name (e.g. to prepare for push to a registry)',
  input: z.object({
    source: z.string().describe('Source image name or ID (e.g. myapp:latest)'),
    target: z.string().describe('Target tag including registry (e.g. registry.io/myapp:v1.2.3)'),
  }),
  async execute({ source, target }) {
    await execDocker(['tag', source, target]);
    return `Tagged ${source} → ${target}`;
  },
});

export const imagePush = defineTool({
  name: 'image_push',
  description: 'Push a Docker image to a registry',
  input: z.object({
    image: z.string().describe('Image name including registry and tag (e.g. registry.io/myapp:v1.2.3)'),
    platform: z.string().optional().describe('Target platform (e.g. linux/amd64)'),
  }),
  async execute({ image, platform }) {
    const args = ['push', image];
    if (platform) args.push('--platform', platform);
    await execDocker(args, 300_000);
    return `Pushed: ${image}`;
  },
});


