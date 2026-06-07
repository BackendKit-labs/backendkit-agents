export class DockerAgentError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DockerAgentError';
  }
}

export class ContainerNotFoundError extends DockerAgentError {
  constructor(containerId: string, details?: Record<string, unknown>) {
    super(`Container not found: ${containerId}`, 'CONTAINER_NOT_FOUND', { containerId, ...details });
    this.name = 'ContainerNotFoundError';
  }
}

export class ContainerNotRunningError extends DockerAgentError {
  constructor(containerId: string, status?: string) {
    super(`Container is not running: ${containerId}`, 'CONTAINER_NOT_RUNNING', { containerId, status });
    this.name = 'ContainerNotRunningError';
  }
}

export class ContainerCreateError extends DockerAgentError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(`Failed to create container: ${message}`, 'CONTAINER_CREATE_ERROR', details);
    this.name = 'ContainerCreateError';
  }
}

export class ContainerExecError extends DockerAgentError {
  constructor(containerId: string, exitCode: number, stderr: string) {
    super(`Exec failed in container ${containerId}`, 'CONTAINER_EXEC_ERROR', {
      containerId, exitCode, stderr,
    });
    this.name = 'ContainerExecError';
  }
}

export class ComposeFileNotFoundError extends DockerAgentError {
  constructor(filePath: string) {
    super(`Compose file not found: ${filePath}`, 'COMPOSE_FILE_NOT_FOUND', { filePath });
    this.name = 'ComposeFileNotFoundError';
  }
}

export class ComposeServiceError extends DockerAgentError {
  constructor(service: string, message: string, details?: Record<string, unknown>) {
    super(`Compose service "${service}" error: ${message}`, 'COMPOSE_SERVICE_ERROR', { service, ...details });
    this.name = 'ComposeServiceError';
  }
}

export class ComposeTimeoutError extends DockerAgentError {
  constructor(command: string, timeoutMs: number) {
    super(`Compose command "${command}" timed out after ${timeoutMs}ms`, 'COMPOSE_TIMEOUT', {
      command, timeoutMs,
    });
    this.name = 'ComposeTimeoutError';
  }
}

export class DockerConnectionError extends DockerAgentError {
  constructor(message: string, details?: Record<string, unknown>) {
    super(`Docker connection failed: ${message}`, 'DOCKER_CONNECTION_ERROR', details);
    this.name = 'DockerConnectionError';
  }
}

export class DockerPermissionError extends DockerAgentError {
  constructor(message: string) {
    super(`Docker permission denied: ${message}`, 'DOCKER_PERMISSION_ERROR');
    this.name = 'DockerPermissionError';
  }
}

export class DockerTimeoutError extends DockerAgentError {
  constructor(operation: string, timeoutMs: number) {
    super(`Docker operation "${operation}" timed out after ${timeoutMs}ms`, 'DOCKER_TIMEOUT', {
      operation, timeoutMs,
    });
    this.name = 'DockerTimeoutError';
  }
}
