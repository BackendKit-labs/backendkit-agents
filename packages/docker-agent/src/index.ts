import { CallbackTransport } from '@backendkit-labs/agent-core';
import { createDockerEngine } from './engine';
import { loadConfig } from './config';

function renderEvent(event: Parameters<CallbackTransport['emit']>[0]): void {
  switch (event.type) {
    case 'ready':
      process.stdout.write('\n🏗️  Infra Agent ready\n\n');
      break;
    case 'token':
      process.stdout.write(event.content);
      break;
    case 'tool_call':
      process.stdout.write(`\n\x1b[90m⚡ ${event.name}\x1b[0m\n`);
      break;
    case 'tool_result':
      process.stdout.write(`\x1b[90m  → ${event.success ? 'ok' : 'error'}\x1b[0m\n`);
      break;
    case 'block_start':
      if (event.agent_name) {
        process.stdout.write(`\n\x1b[1m${event.agent_icon ?? ''} ${event.agent_name}\x1b[0m\n`);
      }
      break;
    case 'block_end':
      if (event.status === 'error') {
        process.stdout.write(`\x1b[31m✗ ${event.agent_id ?? 'error'}\x1b[0m\n`);
      }
      break;
    case 'system':
      process.stdout.write(`\x1b[33m[${(event as { level?: string }).level ?? 'info'}] ${(event as { text?: string }).text ?? ''}\x1b[0m\n`);
      break;
    case 'error':
      process.stdout.write(`\n\x1b[31mError: ${event.message}\x1b[0m\n`);
      break;
    case 'done':
      process.stdout.write('\n');
      break;
  }
}

async function main(): Promise<void> {
  const config = loadConfig();

  if (!config.llmApiKey) {
    console.error('Error: LLM API key not configured.');
    console.error('Set LLM_API_KEY, OPENAI_API_KEY, DEEPSEEK_API_KEY, or ANTHROPIC_API_KEY.');
    process.exit(1);
  }

  const transport = new CallbackTransport(renderEvent);
  const engine = createDockerEngine(transport);

  const input =
    process.argv[2] ||
    process.env.INPUT ||
    'List running containers and show Docker system info';

  await engine.run(input);
}

main().catch(err => {
  console.error('\nFatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
