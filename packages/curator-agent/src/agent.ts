/**
 * CuratorAgent — full agentic knowledge curator
 *
 * Orchestrates quality-checking, tagging, and vault writing via sub-agents.
 * Memory-aware: indexes the vault on startup, updates after every write.
 *
 * Entry points:
 *   process(document, source)  — curate an existing document into the vault
 *   research(topic)            — generate an article with LLM + curate it
 *   researchUrl(url)           — capture a URL via Jina Reader + curate it
 *
 * Required env vars:
 *   DEEPSEEK_API_KEY  (or OPENAI_API_KEY for any OpenAI-compatible provider)
 *
 * Optional:
 *   LLM_MODEL          (default: deepseek-chat)
 *   LLM_BASE_URL       (default: https://api.deepseek.com)
 *   VAULT_MANAGER_URL  (e.g. http://localhost:3000 — enables auto-sync after writes)
 *   VAULT_MANAGER_ID   (vault definition ID in vault-manager DB)
 */

import OpenAI from 'openai';
import {
    AgentEngine,
    AgentRegistry,
    ToolRegistry,
    ProviderRegistry,
    CallbackTransport,
    defineTool,
} from '@backendkit-labs/agent-core';
import type { AgentEvent } from '@backendkit-labs/agent-core';
import { z }              from 'zod';
import { KnowledgeProvider } from './provider.js';
import { VaultMemory }       from './memory/vault-memory.js';
import { createCuratorTools } from './tools/index.js';
import { PROFILES, QUALITY_CHECKER_PROFILE, TAGGER_PROFILE } from './agents/profiles.js';
import type { NoteEntry } from './memory/vault-memory.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CuratorAgentOptions {
    apiKey:      string;
    vaultPath:   string;
    /** Model used by the AgentEngine for orchestration (default: deepseek-chat) */
    model?:      string;
    /** Model used for article generation in research() — cheaper/faster (default: deepseek-chat) */
    researchModel?: string;
    baseUrl?:    string;
    vaultManagerUrl?: string;
    vaultManagerId?:  string;
    onProgress?: (msg: string) => void;
}

export interface ProcessResult {
    written:    string[];
    skipped:    string[];
    enriched:   string[];
    errors:     string[];
    durationMs: number;
}

// ── CuratorAgent ──────────────────────────────────────────────────────────────

export class CuratorAgent {
    private readonly opts: CuratorAgentOptions;
    private memory!:  VaultMemory;
    private engine!:  AgentEngine;
    /** Separate lightweight client for content generation (research mode) */
    private genClient!: OpenAI;
    private written: string[] = [];

    constructor(opts: CuratorAgentOptions) {
        this.opts = opts;
    }

    // ── Setup ──────────────────────────────────────────────────────────────────

    async setup(): Promise<void> {
        const {
            apiKey, vaultPath,
            model    = 'deepseek-chat',
            baseUrl,
            onProgress,
        } = this.opts;

        // Memory
        this.memory = new VaultMemory(vaultPath);
        onProgress?.('Indexing vault memory...');
        await this.memory.load();
        onProgress?.(`Memory loaded: ${this.memory.summary()}`);

        // Generation client (used by research / researchUrl, not the engine)
        this.genClient = new OpenAI({
            apiKey,
            baseURL:    baseUrl ?? 'https://api.deepseek.com',
            maxRetries: 2,
        });

        // Tools
        const tools = createCuratorTools(this.memory, vaultPath, (entry: NoteEntry) => {
            this.written.push(entry.filePath);
        });

        // ask_agent tool — delegates to quality-checker and tagger
        const isReasoner   = (model.includes('reasoner') || /^o\d/.test(model));
        const llmProvider  = new KnowledgeProvider({ apiKey, model, baseUrl, temperature: isReasoner ? 1 : 0.2 });

        const askAgentTool = defineTool({
            name:        'ask_agent',
            description: 'Delegate a task to a specialist sub-agent: "quality-checker" or "tagger".',
            input: z.object({
                agent_id: z.enum(['quality-checker', 'tagger']).describe('Sub-agent to call'),
                task:     z.string().describe('Task description and full context for the sub-agent'),
            }),
            execute: async ({ agent_id, task }: { agent_id: 'quality-checker' | 'tagger'; task: string }) => {
                onProgress?.(`  → delegating to ${agent_id}...`);
                const profile = agent_id === 'quality-checker' ? QUALITY_CHECKER_PROFILE : TAGGER_PROFILE;

                const subTools = new ToolRegistry();
                for (const toolName of profile.allowedTools ?? []) {
                    const tool = (tools as Record<string, ReturnType<typeof defineTool>>)[camelCase(toolName)];
                    if (tool) subTools.register(tool);
                }

                const subAgents    = new AgentRegistry();
                subAgents.register(profile);
                const subProviders = new ProviderRegistry();
                subProviders.register('llm', llmProvider);

                let result = '';
                const subTransport = new CallbackTransport((evt: AgentEvent) => {
                    if (evt.type === 'token') result += evt.content;
                });

                const subEngine = new AgentEngine({
                    model:           { provider: 'llm', id: model },
                    agents:          subAgents,
                    tools:           subTools,
                    providers:       subProviders,
                    defaultProvider: 'llm',
                    defaultAgentId:  agent_id,
                    transport:       subTransport,
                    maxIterations:   10,
                    iterationMode:   'auto',
                });

                await subEngine.run(task);
                onProgress?.(`  ✓ ${agent_id} done`);
                return result || `${agent_id} completed with no text output.`;
            },
        });

        // Registry
        const toolRegistry = new ToolRegistry();
        toolRegistry.register(tools.readVaultIndex);
        toolRegistry.register(tools.checkDuplicate);
        toolRegistry.register(tools.scoreQuality);
        toolRegistry.register(tools.getExistingTags);
        toolRegistry.register(tools.writeToVault);
        toolRegistry.register(tools.notifyVaultManager);
        toolRegistry.register(askAgentTool);

        const agentRegistry = new AgentRegistry();
        for (const profile of Object.values(PROFILES)) agentRegistry.register(profile);

        const providerRegistry = new ProviderRegistry();
        providerRegistry.register('llm', llmProvider);

        const transport = new CallbackTransport((evt: AgentEvent) => {
            switch (evt.type) {
                case 'token':       process.stdout.write(evt.content); break;
                case 'tool_call':   onProgress?.(`  ● ${evt.name}${evt.args_preview ? ` ${evt.args_preview.slice(0, 60)}` : ''}`); break;
                case 'tool_result': onProgress?.(`  ${evt.success ? '✓' : '✗'} ${(evt.preview ?? '').slice(0, 80)}`); break;
            }
        });

        this.engine = new AgentEngine({
            model:           { provider: 'llm', id: model },
            agents:          agentRegistry,
            tools:           toolRegistry,
            providers:       providerRegistry,
            defaultProvider: 'llm',
            defaultAgentId:  'curator',
            transport,
            maxIterations:   30,
            iterationMode:   'auto',
        });
    }

    // ── process ────────────────────────────────────────────────────────────────

    async process(document: string, source: string, areaHint?: string): Promise<ProcessResult> {
        const start = Date.now();
        this.written = [];

        const vmLine = this.vmPromptLine();

        const prompt = [
            `Curate the following document and add it to the vault.`,
            `Source file: ${source}`,
            areaHint ? `Area hint: ${areaHint}` : '',
            vmLine,
            `\nDocument:\n${document.slice(0, 12_000)}`,
        ].filter(Boolean).join('\n');

        const errors: string[] = [];
        try {
            await this.engine.run(prompt);
        } catch (err) {
            errors.push((err as Error).message);
        }

        return { written: this.written, skipped: [], enriched: [], errors, durationMs: Date.now() - start };
    }

    // ── research ───────────────────────────────────────────────────────────────

    async research(topic: string): Promise<ProcessResult> {
        const { onProgress } = this.opts;
        onProgress?.(`\n  Generating article: "${topic}"...`);

        const markdown = await this.generateArticle(topic);
        const sourceRef = `research/${slugify(topic)}`;

        onProgress?.('  Article generated. Curating...');
        return this.process(markdown, sourceRef);
    }

    // ── researchUrl ────────────────────────────────────────────────────────────

    async researchUrl(url: string): Promise<ProcessResult> {
        const { onProgress } = this.opts;
        onProgress?.(`\n  Fetching: ${url}`);

        const markdown = await this.fetchUrl(url);
        onProgress?.(`  Fetched ${markdown.length} chars. Curating...`);

        return this.process(markdown, url);
    }

    // ── Vault memory access ────────────────────────────────────────────────────

    getMemory(): VaultMemory { return this.memory; }

    async reloadMemory(): Promise<void> { await this.memory.load(); }

    // ── Private: content generation ────────────────────────────────────────────

    private async generateArticle(topic: string): Promise<string> {
        const model = this.opts.researchModel ?? 'deepseek-chat';
        const date  = new Date().toISOString().slice(0, 10);

        const resp = await this.genClient.chat.completions.create({
            model,
            temperature: 0.3,
            messages: [
                {
                    role: 'system',
                    content: `You are a technical knowledge curator. Generate a comprehensive markdown article.

IMPORTANT — return ONLY markdown. No extra prose outside the article.

Structure your response as:
---
title: "<specific searchable title>"
area: <general|insights|operaciones|rrhh|finanzas|legal|calidad>
resumen: "<1-2 dense sentences with key terms, max 500 chars>"
tags: ["area/<area>", "tipo/leccion", "<concept-1>", "<concept-2>"]
author: "agent/research"
source_ref: "research/<topic-slug>"
date: ${date}
---

# <Title>

## Overview
...

## Key Concepts
...

## How It Works
...

## Best Practices
...

## References
...

Rules:
- Use ## headings throughout
- Be concrete: include code examples when relevant
- Language: match the topic's natural language (Spanish topics → Spanish article)
- Tags: use existing taxonomy patterns like area/general, tipo/leccion`,
                },
                {
                    role: 'user',
                    content: `Generate a complete knowledge article about: ${topic}`,
                },
            ],
        });

        return resp.choices[0]?.message?.content ?? '';
    }

    private async fetchUrl(url: string): Promise<string> {
        const jinaUrl = `https://r.jina.ai/${url}`;
        const res = await fetch(jinaUrl, {
            headers: { 'Accept': 'text/markdown', 'X-Return-Format': 'markdown' },
            signal:  AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`Jina returned ${res.status} for ${url}`);
        const text = await res.text();
        if (!text || text.length < 100) throw new Error(`Empty response from Jina for ${url}`);
        return text;
    }

    // ── Private: helpers ───────────────────────────────────────────────────────

    private vmPromptLine(): string {
        const { vaultManagerUrl: url, vaultManagerId: id } = this.opts;
        return url && id
            ? `\nAfter writing, call notify_vault_manager with url="${url}" and vault_id="${id}".`
            : '';
    }
}

// ── Module helpers ─────────────────────────────────────────────────────────────

function camelCase(name: string): string {
    return name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
}

function slugify(title: string): string {
    return title.toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9\s-]/g, '')
        .trim().replace(/\s+/g, '-').slice(0, 60);
}
