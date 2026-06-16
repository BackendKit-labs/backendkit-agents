import Dockerode from 'dockerode';
import * as os    from 'node:os';

// ── Public types ───────────────────────────────────────────────────────────────

export interface DeploySpec {
    id:             string;
    image:          string;
    containerPort?: number;          // port the agent listens on inside the container (default 8080)
    env?:           Record<string, string>;
    memoryMb?:      number;
    cpus?:          number;          // fractional, e.g. 0.5
    apiKey?:        string;
    description?:   string;
    strategy?:      string;
    capability?:    string;
}

export interface RunningInstance {
    instanceId: string;              // Docker container ID (short)
    agentId:    string;
    image:      string;
    url:        string;
    status:     string;              // 'running' | 'exited' | ...
    createdAt:  string;              // ISO timestamp
}

export interface AgentRuntime {
    deploy(spec: DeploySpec):          Promise<{ url: string; instanceId: string }>;
    stopByAgentId(agentId: string):    Promise<void>;
    list():                            Promise<RunningInstance[]>;
}

// ── Label constants ────────────────────────────────────────────────────────────

const LABEL_PLATFORM = 'mcp.platform';
const LABEL_AGENT_ID = 'mcp.agent.id';

// ── DockerRuntime ──────────────────────────────────────────────────────────────

export class DockerRuntime implements AgentRuntime {
    private readonly docker: Dockerode;

    constructor() {
        // DOCKER_HOST env var → explicit host override
        // Windows Docker Desktop → named pipe
        // Linux / macOS          → unix socket (dockerode default)
        if (process.env['DOCKER_HOST']) {
            const u = new URL(process.env['DOCKER_HOST']!);
            this.docker = new Dockerode({ host: u.hostname, port: Number(u.port) || 2375 });
        } else if (os.platform() === 'win32') {
            this.docker = new Dockerode({ socketPath: '//./pipe/docker_engine' });
        } else {
            this.docker = new Dockerode();
        }
    }

    // ── deploy ─────────────────────────────────────────────────────────────────

    async deploy(spec: DeploySpec): Promise<{ url: string; instanceId: string }> {
        const containerPort = spec.containerPort ?? 8080;
        const containerName = `mcp-agent-${spec.id}`;

        const env: string[] = Object.entries(spec.env ?? {}).map(([k, v]) => `${k}=${v}`);
        if (spec.apiKey) env.push(`AGENT_API_KEY=${spec.apiKey}`);

        await this._pullIfMissing(spec.image);
        await this._removeExisting(containerName);

        const container = await this.docker.createContainer({
            name:  containerName,
            Image: spec.image,
            Env:   env.length ? env : undefined,
            Labels: {
                [LABEL_PLATFORM]: 'true',
                [LABEL_AGENT_ID]: spec.id,
            },
            ExposedPorts: { [`${containerPort}/tcp`]: {} },
            HostConfig: {
                // HostPort: '' → Docker auto-assigns a free port from the ephemeral range
                PortBindings: { [`${containerPort}/tcp`]: [{ HostPort: '' }] },
                RestartPolicy: { Name: 'unless-stopped' },
                ...(spec.memoryMb && { Memory: spec.memoryMb * 1024 * 1024 }),
                ...(spec.cpus     && { NanoCpus: Math.round(spec.cpus * 1e9) }),
            },
        });

        await container.start();

        const info     = await container.inspect();
        const bindings = info.NetworkSettings.Ports[`${containerPort}/tcp`];
        if (!bindings?.[0]) {
            await container.stop({ t: 2 }).catch(() => {});
            await container.remove({ force: true }).catch(() => {});
            throw new Error(`Container started but port ${containerPort}/tcp has no host binding`);
        }

        const hostPort = bindings[0].HostPort;
        return {
            url:        `http://localhost:${hostPort}`,
            instanceId: info.Id.slice(0, 12),
        };
    }

    // ── stopByAgentId ─────────────────────────────────────────────────────────

    async stopByAgentId(agentId: string): Promise<void> {
        const containers = await this.docker.listContainers({
            all:     true,
            filters: JSON.stringify({ label: [`${LABEL_AGENT_ID}=${agentId}`] }),
        });

        await Promise.all(containers.map(async c => {
            const container = this.docker.getContainer(c.Id);
            if (c.State === 'running') await container.stop({ t: 5 }).catch(() => {});
            await container.remove({ force: true }).catch(() => {});
        }));
    }

    // ── list ──────────────────────────────────────────────────────────────────

    async list(): Promise<RunningInstance[]> {
        const containers = await this.docker.listContainers({
            all:     true,
            filters: JSON.stringify({ label: [`${LABEL_PLATFORM}=true`] }),
        });

        return containers.map(c => {
            const binding  = c.Ports?.find(p => p.PublicPort);
            const hostPort = binding?.PublicPort;

            return {
                instanceId: c.Id.slice(0, 12),
                agentId:    c.Labels?.[LABEL_AGENT_ID] ?? '',
                image:      c.Image,
                url:        hostPort ? `http://localhost:${hostPort}` : '',
                status:     c.State,
                createdAt:  new Date(c.Created * 1000).toISOString(),
            };
        });
    }

    // ── private helpers ───────────────────────────────────────────────────────

    private async _pullIfMissing(image: string): Promise<void> {
        try {
            await this.docker.getImage(image).inspect();
            return;
        } catch { /* image not present locally — pull it */ }

        await new Promise<void>((resolve, reject) => {
            this.docker.pull(image, (err: Error | null, stream: NodeJS.ReadableStream) => {
                if (err) return reject(new Error(`Pull failed for "${image}": ${err.message}`));
                this.docker.modem.followProgress(
                    stream,
                    (err: Error | null) => (err ? reject(err) : resolve()),
                );
            });
        });
    }

    private async _removeExisting(containerName: string): Promise<void> {
        try {
            const c    = this.docker.getContainer(containerName);
            const info = await c.inspect();
            if (info.State.Running) await c.stop({ t: 2 }).catch(() => {});
            await c.remove({ force: true });
        } catch { /* container doesn't exist — nothing to do */ }
    }
}
