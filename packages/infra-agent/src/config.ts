import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

export interface InfraAgentConfig {
  dockerSocketPath: string;
  dockerHost: string | null;
  platform: string;
  defaultTimeout: number;
  llmProvider: string;
  llmApiKey: string;
  llmBaseUrl: string;
  llmModel: string;
  mcpPort: number;
  mcpHost: string;
  kubeconfig: string | null;
  k8sNamespace: string;
  containerdNamespace: string;
  containerdRuntime: 'nerdctl' | 'ctr';
}

export function loadConfig(): InfraAgentConfig {
  return {
    dockerSocketPath: process.env.DOCKER_SOCKET_PATH || '',
    dockerHost: process.env.DOCKER_HOST || null,
    platform: process.platform,
    defaultTimeout: parseInt(process.env.DEFAULT_TIMEOUT || '30000', 10),
    llmProvider: process.env.LLM_PROVIDER || 'openai',
    llmApiKey:
      process.env.LLM_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.DEEPSEEK_API_KEY ||
      process.env.ANTHROPIC_API_KEY ||
      '',
    llmBaseUrl:
      process.env.LLM_BASE_URL ||
      process.env.OPENAI_BASE_URL ||
      'https://api.openai.com/v1',
    llmModel: process.env.LLM_MODEL || 'gpt-4o',
    mcpPort: parseInt(process.env.MCP_PORT || '3100', 10),
    mcpHost: process.env.MCP_HOST || '127.0.0.1',
    kubeconfig: process.env.KUBECONFIG || null,
    k8sNamespace: process.env.K8S_NAMESPACE || 'default',
    containerdNamespace: process.env.CONTAINERD_NAMESPACE || 'default',
    containerdRuntime: (process.env.CONTAINERD_RUNTIME as 'nerdctl' | 'ctr') || 'nerdctl',
  };
}
