#!/usr/bin/env node
/**
 * knowledge-agent — interactive REPL backed by any Obsidian vault
 *
 * The agent searches the configured vault before every response,
 * writes insights back, and improves the vault over time.
 *
 * Required env vars:
 *   DEEPSEEK_API_KEY   (or OPENAI_API_KEY for OpenAI-compatible providers)
 *
 * Optional:
 *   VAULT_PATH         path to the knowledge vault (default: ai-vault)
 *   LLM_MODEL          model to use (default: deepseek-reasoner)
 *   LLM_BASE_URL       custom base URL (default: DeepSeek API)
 *   AGENT_PROFILE      starting profile: architect | reviewer (default: architect)
 *   MAX_CONTEXT        max conversation messages (default: 40)
 *
 * Usage:
 *   DEEPSEEK_API_KEY=sk-... VAULT_PATH=/path/to/vault npx knowledge-agent
 */

import 'dotenv/config';
import * as readline from 'readline';
import * as path     from 'path';
import * as os       from 'os';
import {
    AgentEngine,
    AgentRegistry,
    ToolRegistry,
    ProviderRegistry,
    CallbackTransport,
} from '@backendkit-labs/agent-core';
import type { AgentEvent } from '@backendkit-labs/agent-core';
import { ObsidianRAGProvider, VaultWriter, SimpleEmbedder } from '@backendkit-labs/agent-enterprise';
import { CuratorClient }      from '@backendkit-labs/curator-agent';
import { KnowledgeProvider }  from './provider';
import { PROFILES }           from './profiles';

// ── Config ────────────────────────────────────────────────────────────────────

const API_KEY      = process.env.DEEPSEEK_API_KEY ?? process.env.OPENAI_API_KEY ?? '';
const LLM_MODEL    = process.env.LLM_MODEL    ?? 'deepseek-reasoner';
const LLM_BASE_URL = process.env.LLM_BASE_URL;
const VAULT_PATH   = process.env.VAULT_PATH   ?? path.join(os.homedir(), 'development/workspace-ia/ai-vault');
const START_AGENT  = process.env.AGENT_PROFILE ?? 'architect';
const IS_REASONER  = LLM_MODEL.includes('reasoner') || /^o\d/.test(LLM_MODEL);
const INDEX_PATH   = path.join(os.homedir(), '.bk-agent', 'rag', path.basename(VAULT_PATH) + '.json');

// ── REPL commands ─────────────────────────────────────────────────────────────

const CURATOR_URL = process.env.CURATOR_URL ?? 'http://localhost:3100';

const COMMANDS: Record<string, string> = {
    '/help':                    'Show available commands',
    '/clear':                   'Clear conversation history',
    '/reindex':                 'Re-index the vault (picks up new notes)',
    '/agent architect':         'Switch to architect profile (design + best practices)',
    '/agent reviewer':          'Switch to reviewer profile (code + architecture review)',
    '/vault':                   'Show vault path and index stats',
    '/research <tema>':         'Generate & save article on a topic using LLM',
    '/research --url <url>':    'Capture & save a URL\'s content via Jina Reader',
    '/quit':                    'Exit',
};

function printBanner(indexed: number): void {
    const vaultName = path.basename(VAULT_PATH);
    console.log('');
    console.log('  ╔══════════════════════════════════════════════════╗');
    console.log('  ║            Knowledge Agent — BackendKit Labs      ║');
    console.log('  ╚══════════════════════════════════════════════════╝');
    console.log(`  Vault:    ${VAULT_PATH}`);
    console.log(`  Index:    ${indexed} chunks indexed`);
    console.log(`  LLM:      ${LLM_MODEL}${IS_REASONER ? '  (reasoning mode)' : ''}`);
    console.log(`  Profile:  ${START_AGENT}`);
    console.log('');
    console.log(`  Ask anything about the knowledge in "${vaultName}".`);
    console.log('  Type /help for commands.\n');
}

function printHelp(): void {
    console.log('\n  Commands:');
    for (const [cmd, desc] of Object.entries(COMMANDS)) {
        console.log(`    ${cmd.padEnd(24)} ${desc}`);
    }
    console.log('');
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    if (!API_KEY) {
        console.error('✗  DEEPSEEK_API_KEY (or OPENAI_API_KEY) is required.');
        process.exit(1);
    }

    if (!Object.keys(PROFILES).includes(START_AGENT)) {
        console.error(`✗  Unknown AGENT_PROFILE "${START_AGENT}". Use: architect | reviewer`);
        process.exit(1);
    }

    // ── RAG ───────────────────────────────────────────────────────────────────
    const rag = new ObsidianRAGProvider({
        vaultPath: VAULT_PATH,
        indexPath: INDEX_PATH,
        embedder:  new SimpleEmbedder(),
        topK:      5,
        minScore:  0.1,
    });

    const writer = new VaultWriter({ vaultPath: VAULT_PATH, agentFolder: 'insights' });

    // ── Curator MCP client ────────────────────────────────────────────────────
    const curator = new CuratorClient(CURATOR_URL);

    process.stdout.write('  Indexing vault... ');
    const { indexed } = await rag.index({ verbose: false });
    printBanner(indexed);

    // ── Registry ──────────────────────────────────────────────────────────────
    const tools = new ToolRegistry();
    tools.register(rag.createTool());
    tools.register(writer.createTool('knowledge'));

    const agents = new AgentRegistry();
    for (const profile of Object.values(PROFILES)) agents.register(profile);

    const providers = new ProviderRegistry();
    providers.register('llm', new KnowledgeProvider({
        apiKey:   API_KEY,
        model:    LLM_MODEL,
        baseUrl:  LLM_BASE_URL,
        temperature: IS_REASONER ? 1 : 0,
    }));

    // ── Transport ─────────────────────────────────────────────────────────────
    let currentAgentId = START_AGENT;

    const transport = new CallbackTransport((evt: AgentEvent) => {
        switch (evt.type) {
            case 'token':
                process.stdout.write(evt.content);
                break;
            case 'tool_call': {
                const preview = evt.args_preview ? ` ${evt.args_preview.slice(0, 80)}` : '';
                console.log(`\n  [${evt.name}]${preview}`);
                break;
            }
            case 'tool_result': {
                const preview = (evt.preview ?? '').slice(0, 100).replace(/\n/g, ' ');
                console.log(`  ${evt.success ? '✓' : '✗'} ${preview}`);
                break;
            }
            case 'agent_switch':
                currentAgentId = evt.to ?? currentAgentId;
                break;
        }
    });

    // ── Engine ────────────────────────────────────────────────────────────────
    const engine = new AgentEngine({
        model:           { provider: 'llm', id: LLM_MODEL },
        agents,
        tools,
        providers,
        defaultProvider: 'llm',
        defaultAgentId:  START_AGENT,
        transport,
        maxIterations:   20,
        iterationMode:   'auto',
    });

    // ── REPL ──────────────────────────────────────────────────────────────────
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });

    const prompt = (): void => {
        const p = PROFILES[currentAgentId] ?? PROFILES['architect']!;
        rl.question(`\n  [${p.icon} ${p.name}] > `, async (input) => {
            const line = input.trim();
            if (!line) { prompt(); return; }

            if (line === '/quit' || line === '/exit') { console.log('\n  Goodbye.\n'); rl.close(); return; }
            if (line === '/help')    { printHelp(); prompt(); return; }
            if (line === '/vault')   { console.log(`\n  Vault: ${VAULT_PATH}\n  Index: ${INDEX_PATH}\n`); prompt(); return; }
            if (line === '/clear')   { engine.clearHistory(); console.log('  History cleared.\n'); prompt(); return; }

            if (line === '/reindex') {
                process.stdout.write('  Re-indexing... ');
                const r = await rag.index({ verbose: false });
                console.log(`${r.indexed} new chunks.\n`);
                prompt(); return;
            }

            if (line.startsWith('/agent ')) {
                const id = line.slice(7).trim();
                if (PROFILES[id]) {
                    engine.switchAgent(id);
                    currentAgentId = id;
                    const p2 = PROFILES[id]!;
                    console.log(`  Switched to ${p2.icon} ${p2.name}.\n`);
                } else {
                    console.log(`  Unknown profile "${id}". Available: ${Object.keys(PROFILES).join(', ')}\n`);
                }
                prompt(); return;
            }

            if (line.startsWith('/research ') || line === '/research') {
                const args = line.slice('/research'.length).trim();
                if (!args) {
                    console.log('  Usage: /research <topic>  or  /research --url <url>\n');
                    prompt(); return;
                }
                console.log('');
                try {
                    const urlMatch = args.match(/^--url\s+(\S+)/);
                    const result   = urlMatch
                        ? await curator.researchUrl(urlMatch[1]!)
                        : await curator.research(args);

                    if (result.errors.length)   console.log(`\n  ✗ ${result.errors[0]}`);
                    else if (result.written.length) {
                        console.log(`\n  ✓ Written: ${result.written[0]}`);
                        process.stdout.write('  Updating index... ');
                        const r = await rag.index({ verbose: false });
                        console.log(`${r.indexed} new chunks.\n`);
                    } else {
                        console.log(`\n  ⊘ Skipped (duplicate or already exists)`);
                    }
                } catch (err) {
                    console.error(`\n  Research error: ${(err as Error).message}`);
                }
                console.log('');
                prompt(); return;
            }

            if (line.startsWith('/')) { console.log('  Unknown command. Type /help.\n'); prompt(); return; }

            // ── Run ───────────────────────────────────────────────────────────
            console.log('');
            const agentBeforeRun = currentAgentId;
            try {
                await engine.run(line);
            } catch (err) {
                console.error(`\n  Error: ${(err as Error).message}`);
            }
            // Restore after ask_agent delegation
            currentAgentId = agentBeforeRun;
            engine.switchAgent(agentBeforeRun);
            console.log('');

            // Re-index so insights written this turn are searchable next turn
            await rag.index({ verbose: false });

            prompt();
        });
    };

    prompt();
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
