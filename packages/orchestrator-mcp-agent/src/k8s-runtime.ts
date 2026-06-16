import * as k8s from '@kubernetes/client-node';
import type { DeploySpec, RunningInstance, AgentRuntime } from './runtime.js';

// ── Label constants (must match runtime.ts) ───────────────────────────────────

const LABEL_PLATFORM = 'mcp.platform';
const LABEL_AGENT_ID = 'mcp.agent.id';
const LABEL_SELECTOR = `${LABEL_PLATFORM}=true`;

// ── Service type ──────────────────────────────────────────────────────────────

export type K8sServiceType = 'NodePort' | 'LoadBalancer' | 'ClusterIP';

export interface K8sRuntimeOptions {
    namespace?:   string;          // default: 'mcp-agents'
    serviceType?: K8sServiceType;  // default: 'NodePort' (local k3d/kind/Docker Desktop)
    nodeHost?:    string;          // NodePort host, default: 'localhost'
    inCluster?:   boolean;         // load in-cluster config instead of ~/.kube/config
}

// ── KubernetesRuntime ─────────────────────────────────────────────────────────

export class KubernetesRuntime implements AgentRuntime {
    private readonly appsApi:     k8s.AppsV1Api;
    private readonly coreApi:     k8s.CoreV1Api;
    private readonly namespace:   string;
    private readonly serviceType: K8sServiceType;
    private readonly nodeHost:    string;

    constructor(opts: K8sRuntimeOptions = {}) {
        this.namespace   = opts.namespace   ?? 'mcp-agents';
        this.serviceType = opts.serviceType ?? 'NodePort';
        this.nodeHost    = opts.nodeHost    ?? 'localhost';

        const kc = new k8s.KubeConfig();
        if (opts.inCluster) {
            kc.loadFromCluster();
        } else {
            kc.loadFromDefault();
        }

        this.appsApi = kc.makeApiClient(k8s.AppsV1Api);
        this.coreApi = kc.makeApiClient(k8s.CoreV1Api);
    }

    // ── deploy ─────────────────────────────────────────────────────────────────

    async deploy(spec: DeploySpec): Promise<{ url: string; instanceId: string }> {
        const containerPort = spec.containerPort ?? 8080;
        const name          = this._resourceName(spec.id);

        const labels: Record<string, string> = {
            [LABEL_PLATFORM]: 'true',
            [LABEL_AGENT_ID]: spec.id,
            app:              name,
        };

        const envVars: k8s.V1EnvVar[] = [
            ...Object.entries(spec.env ?? {}).map(([n, value]) => ({ name: n, value })),
            ...(spec.apiKey ? [{ name: 'AGENT_API_KEY', value: spec.apiKey }] : []),
        ];

        await this._ensureNamespace();
        await this._applyDeployment({ name, image: spec.image, containerPort, envVars, labels, spec });
        const svc = await this._applyService({ name, containerPort, labels });
        const url = this._urlFromService(svc, containerPort);

        return { url, instanceId: name };
    }

    // ── stopByAgentId ─────────────────────────────────────────────────────────

    async stopByAgentId(agentId: string): Promise<void> {
        const name = this._resourceName(agentId);
        await Promise.all([
            this.appsApi.deleteNamespacedDeployment({ name, namespace: this.namespace }).catch(() => {}),
            this.coreApi.deleteNamespacedService({ name, namespace: this.namespace }).catch(() => {}),
        ]);
    }

    // ── list ──────────────────────────────────────────────────────────────────

    async list(): Promise<RunningInstance[]> {
        const [deployList, svcList] = await Promise.all([
            this.appsApi.listNamespacedDeployment({ namespace: this.namespace, labelSelector: LABEL_SELECTOR }),
            this.coreApi.listNamespacedService({ namespace: this.namespace, labelSelector: LABEL_SELECTOR }),
        ]);

        // Index services by name for O(1) lookup
        const svcByName = new Map(
            (svcList.items ?? []).map(s => [s.metadata!.name!, s]),
        );

        return (deployList.items ?? []).map(d => {
            const depName = d.metadata!.name!;
            const agentId = d.metadata!.labels?.[LABEL_AGENT_ID] ?? '';
            const ready   = (d.status?.readyReplicas ?? 0) > 0;
            const svc     = svcByName.get(depName);
            const url     = svc ? this._urlFromService(svc, d.spec?.template.spec?.containers[0]?.ports?.[0]?.containerPort ?? 8080) : '';

            return {
                instanceId: depName,
                agentId,
                image:     d.spec?.template.spec?.containers[0]?.image ?? '',
                url,
                status:    ready ? 'running' : 'pending',
                createdAt: d.metadata?.creationTimestamp?.toISOString() ?? new Date().toISOString(),
            };
        });
    }

    // ── private helpers ───────────────────────────────────────────────────────

    private _resourceName(agentId: string): string {
        // K8s names: lowercase alphanumeric + hyphens, max 63 chars
        return `mcp-${agentId.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 58)}`;
    }

    private async _ensureNamespace(): Promise<void> {
        try {
            await this.coreApi.readNamespace({ name: this.namespace });
        } catch {
            await this.coreApi.createNamespace({
                body: { metadata: { name: this.namespace, labels: { [LABEL_PLATFORM]: 'true' } } },
            });
        }
    }

    private async _applyDeployment(p: {
        name:          string;
        image:         string;
        containerPort: number;
        envVars:       k8s.V1EnvVar[];
        labels:        Record<string, string>;
        spec:          DeploySpec;
    }): Promise<void> {
        const { name, image, containerPort, envVars, labels, spec } = p;

        const body: k8s.V1Deployment = {
            metadata: { name, namespace: this.namespace, labels },
            spec: {
                replicas: 1,
                selector: { matchLabels: { app: name } },
                template: {
                    metadata: { labels },
                    spec: {
                        containers: [{
                            name:  'agent',
                            image,
                            ports: [{ containerPort }],
                            env:   envVars.length ? envVars : undefined,
                            resources: (spec.memoryMb || spec.cpus) ? {
                                limits: {
                                    ...(spec.memoryMb && { memory: `${spec.memoryMb}Mi` }),
                                    ...(spec.cpus     && { cpu:    `${Math.round(spec.cpus * 1000)}m` }),
                                },
                            } : undefined,
                            // Liveness + readiness use the /health endpoint every agent exposes
                            livenessProbe: {
                                httpGet: { path: '/health', port: containerPort as unknown as object },
                                initialDelaySeconds: 15,
                                periodSeconds:       20,
                                failureThreshold:    3,
                            },
                            readinessProbe: {
                                httpGet: { path: '/health', port: containerPort as unknown as object },
                                initialDelaySeconds: 5,
                                periodSeconds:       5,
                            },
                        }],
                    },
                },
            },
        };

        try {
            // Check if it already exists
            const existing = await this.appsApi.readNamespacedDeployment({ name, namespace: this.namespace });
            // Preserve resourceVersion for optimistic concurrency
            body.metadata!.resourceVersion = existing.metadata?.resourceVersion;
            await this.appsApi.replaceNamespacedDeployment({ name, namespace: this.namespace, body });
        } catch (e: unknown) {
            if ((e as { statusCode?: number }).statusCode === 404) {
                await this.appsApi.createNamespacedDeployment({ namespace: this.namespace, body });
            } else {
                throw e;
            }
        }
    }

    private async _applyService(p: {
        name:          string;
        containerPort: number;
        labels:        Record<string, string>;
    }): Promise<k8s.V1Service> {
        const { name, containerPort, labels } = p;

        const body: k8s.V1Service = {
            metadata: { name, namespace: this.namespace, labels },
            spec: {
                type:     this.serviceType,
                selector: { app: name },
                ports:    [{ port: containerPort, targetPort: containerPort as unknown as object, protocol: 'TCP' }],
            },
        };

        try {
            const existing = await this.coreApi.readNamespacedService({ name, namespace: this.namespace });
            body.metadata!.resourceVersion = existing.metadata?.resourceVersion;
            // For NodePort: preserve the existing nodePort so it doesn't change on updates
            const existingNodePort = existing.spec?.ports?.[0]?.nodePort;
            if (this.serviceType === 'NodePort' && existingNodePort) {
                body.spec!.ports![0].nodePort = existingNodePort;
            }
            return (await this.coreApi.replaceNamespacedService({ name, namespace: this.namespace, body }));
        } catch (e: unknown) {
            if ((e as { statusCode?: number }).statusCode === 404) {
                return (await this.coreApi.createNamespacedService({ namespace: this.namespace, body }));
            }
            throw e;
        }
    }

    private _urlFromService(svc: k8s.V1Service, containerPort: number): string {
        switch (this.serviceType) {
            case 'NodePort': {
                const nodePort = svc.spec?.ports?.[0]?.nodePort;
                return nodePort ? `http://${this.nodeHost}:${nodePort}` : '';
            }
            case 'LoadBalancer': {
                const ingress = svc.status?.loadBalancer?.ingress?.[0];
                const host    = ingress?.hostname ?? ingress?.ip;
                return host ? `http://${host}:${containerPort}` : '';
            }
            case 'ClusterIP': {
                return `http://${svc.metadata?.name}.${this.namespace}.svc.cluster.local:${containerPort}`;
            }
        }
    }
}
