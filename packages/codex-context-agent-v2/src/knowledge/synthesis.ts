import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { CuratorLLMProvider } from '../providers/types.js';
import type { RagSearchResult } from './rag-provider.js';

export interface SynthesizedNote {
    title: string;
    content: string;
    basedOn: string[];
    synthesisVersion: number;
    generatedAt: string;
}

const SYNTHESIS_PROMPT = `You are a knowledge synthesis expert.

Given a search query and relevant documents from a vault, generate a comprehensive synthetic note that:
1. Directly answers the query
2. Integrates insights from multiple documents
3. Adds clarifying context and practical examples
4. Is self-contained (reader doesn't need originals)
5. Uses markdown with ## headings

Query: {query}

Relevant Documents:
{documents}

Generate a markdown note that synthesizes these documents into a helpful guide.
Return ONLY the markdown content, no frontmatter.`;

export class KnowledgeSynthesizer {
    private provider: CuratorLLMProvider;
    private vaultPath: string;

    constructor(provider: CuratorLLMProvider, vaultPath: string) {
        this.provider = provider;
        this.vaultPath = vaultPath;
    }

    async synthesize(query: string, searchResults: RagSearchResult[]): Promise<SynthesizedNote | null> {
        if (searchResults.length === 0) return null;

        const documentsText = searchResults
            .map((r, i) => `## Document ${i + 1}: ${r.title}\n\n${r.content.slice(0, 1000)}`)
            .join('\n\n---\n\n');

        const prompt = SYNTHESIS_PROMPT
            .replace('{query}', query)
            .replace('{documents}', documentsText);

        try {
            const synthesizedContent = await this.provider.complete(
                'You are a knowledge synthesis expert. Generate high-quality markdown notes.',
                prompt,
                { json: false }
            );

            // Guard against empty/whitespace responses — don't save a blank synthesis note.
            if (!synthesizedContent || synthesizedContent.trim().length === 0) {
                console.error('Synthesis returned empty content — skipping note.');
                return null;
            }

            return {
                title: `${query} — Synthesis`,
                content: synthesizedContent,
                basedOn: searchResults.map(r => r.title),
                synthesisVersion: 1,
                generatedAt: new Date().toISOString(),
            };
        } catch (err) {
            console.error('Synthesis failed:', err);
            return null;
        }
    }

    async saveNote(note: SynthesizedNote, domainFolder: string = 'synthesis'): Promise<string | null> {
        try {
            const dir = path.join(this.vaultPath, domainFolder);
            await fs.mkdir(dir, { recursive: true });

            const slug = note.title
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, '-')
                .slice(0, 60);

            const date = new Date().toISOString().slice(0, 10);
            const filename = `${date}-${slug}-v${note.synthesisVersion}.md`;
            const filePath = path.join(dir, filename);

            try {
                await fs.access(filePath);
                return null;
            } catch {
                // doesn't exist — proceed
            }

            const frontmatter = [
                '---',
                `title: "${note.title.replace(/"/g, '\\"')}"`,
                'area: synthesis',
                'tipo: synthesis',
                'generated_by: knowledge-agent',
                `synthesis_version: ${note.synthesisVersion}`,
                `based_on: [${note.basedOn.map(b => `"${b}"`).join(', ')}]`,
                `date: ${new Date().toISOString().slice(0, 10)}`,
                'author: "agent/codex"',
                'tags: ["synthesis", "generated"]',
                '---',
                '',
                note.content,
            ].join('\n');

            await fs.writeFile(filePath, frontmatter, 'utf-8');
            return filePath;
        } catch (err) {
            console.error('Failed to save note:', err);
            return null;
        }
    }
}
