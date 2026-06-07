import { CallbackTransport } from '@backendkit-labs/agent-core';
import { createK8sEngine } from './engine';
import { loadConfig } from './config';

async function main(): Promise<void> {
  const config = loadConfig();

  if (!config.llmApiKey) {
    console.error('Error: LLM API key not configured.');
    console.error('Set LLM_API_KEY, OPENAI_API_KEY, or ANTHROPIC_API_KEY.');
    process.exit(1);
  }

  const transport = new CallbackTransport((event) => {
    switch (event.type) {
      case 'ready':   process.stdout.write('\n☸️  K8s Agent ready\n\n'); break;
      case 'token':   process.stdout.write(event.content); break;
      case 'tool_call': process.stdout.write(`\n\x1b[90m⚡ ${event.name}\x1b[0m\n`); break;
      case 'tool_result': process.stdout.write(`\x1b[90m  → ${event.success ? 'ok' : 'error'}\x1b[0m\n`); break;
      case 'error':   process.stdout.write(`\n\x1b[31mError: ${event.message}\x1b[0m\n`); break;
      case 'done':    process.stdout.write('\n'); break;
    }
  });

  const engine = createK8sEngine(transport);
  const input = process.argv[2] || process.env.INPUT || 'Get all pods in all namespaces';
  await engine.run(input);
}

main().catch(err => {
  console.error('Fatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
