export interface PortMapping {
  hostPort: number;
  containerPort: number;
  protocol: 'tcp' | 'udp';
}

export interface ContainerSpec {
  image: string;
  name?: string;
  cmd?: string[];
  env?: string[];
  ports?: PortMapping[];
  volumes?: string[];
  networkMode?: string;
  workingDir?: string;
  entrypoint?: string[];
  labels?: Record<string, string>;
  restartPolicy?: 'no' | 'always' | 'on-failure' | 'unless-stopped';
}

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  status: string;
  state: string;
  created: string;
  ports: PortMapping[];
  labels: Record<string, string>;
  networkSettings: Record<string, unknown>;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ComposeServiceInfo {
  name: string;
  image: string;
  state: string;
  ports: string;
  status: string;
}

export interface ComposeSpec {
  filePath: string;
  projectName?: string;
  services?: string[];
}
