#!/usr/bin/env node
/**
 * Workspace Manager — Agnóstic MCP Server
 * Manage curator vaults across any agent (bk-agent, Claude Desktop, etc.)
 *
 * Features:
 *   • List available workspaces
 *   • Switch active workspace
 *   • Create/update/delete workspaces
 *   • Show workspace details
 *
 * Environment:
 *   BK_AGENT_DIR    — Path to .bk-agent directory (auto-detected)
 *
 * Usage:
 *   # Start MCP server
 *   npm start
 *
 *   # Use in bk-agent config.json
 *   {
 *     "name": "workspace-manager",
 *     "command": "node",
 *     "args": ["path/to/dist/server.js"]
 *   }
 *
 *   # Use in Claude Desktop config
 *   {
 *     "workspace-manager": {
 *       "command": "node",
 *       "args": ["path/to/dist/server.js"]
 *     }
 *   }
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// ── Types ────────────────────────────────────────────────────────────────────

interface Workspace {
  name: string;
  inputPath: string;
  outputPath: string;
  description?: string;
}

interface WorkspaceConfig {
  workspaces: Workspace[];
  lastUsed: string;
  version: string;
}

// ── Workspace Manager ────────────────────────────────────────────────────────

class WorkspaceManager {
  private configPath: string;
  private config: WorkspaceConfig;

  constructor(bkAgentDir?: string) {
    const agentDir = bkAgentDir ||
      process.env.BK_AGENT_DIR ||
      path.join(process.env.HOME || process.env.USERPROFILE || '', '.bk-agent');

    this.configPath = path.join(agentDir, 'curator-workspace.json');
    this.config = this.load();
  }

  private load(): WorkspaceConfig {
    try {
      if (!fs.existsSync(this.configPath)) {
        return {
          workspaces: [],
          lastUsed: '',
          version: '1.0.0',
        };
      }
      const content = fs.readFileSync(this.configPath, 'utf-8');
      return JSON.parse(content);
    } catch (err) {
      console.error(`[workspace-manager] Failed to load config: ${(err as Error).message}`);
      return {
        workspaces: [],
        lastUsed: '',
        version: '1.0.0',
      };
    }
  }

  private save(): void {
    try {
      fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf-8');
    } catch (err) {
      console.error(`[workspace-manager] Failed to save config: ${(err as Error).message}`);
    }
  }

  list(): Workspace[] {
    return this.config.workspaces;
  }

  getCurrent(): { workspace: Workspace | null; name: string } {
    const name = this.config.lastUsed;
    const workspace = this.config.workspaces.find(w => w.name === name);
    return { workspace: workspace || null, name };
  }

  switch(name: string): { success: boolean; workspace?: Workspace; error?: string } {
    const workspace = this.config.workspaces.find(w => w.name === name);
    if (!workspace) {
      return {
        success: false,
        error: `Workspace "${name}" not found`,
      };
    }
    this.config.lastUsed = name;
    this.save();
    return { success: true, workspace };
  }

  add(workspace: Workspace): { success: boolean; error?: string } {
    if (this.config.workspaces.some(w => w.name === workspace.name)) {
      return {
        success: false,
        error: `Workspace "${workspace.name}" already exists`,
      };
    }
    this.config.workspaces.push(workspace);
    this.save();
    return { success: true };
  }

  update(name: string, updates: Partial<Workspace>): { success: boolean; workspace?: Workspace; error?: string } {
    const idx = this.config.workspaces.findIndex(w => w.name === name);
    if (idx === -1) {
      return { success: false, error: `Workspace "${name}" not found` };
    }
    this.config.workspaces[idx] = { ...this.config.workspaces[idx], ...updates };
    this.save();
    return { success: true, workspace: this.config.workspaces[idx] };
  }

  remove(name: string): { success: boolean; error?: string } {
    const idx = this.config.workspaces.findIndex(w => w.name === name);
    if (idx === -1) {
      return { success: false, error: `Workspace "${name}" not found` };
    }
    this.config.workspaces.splice(idx, 1);
    if (this.config.lastUsed === name) {
      this.config.lastUsed = this.config.workspaces[0]?.name || '';
    }
    this.save();
    return { success: true };
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const manager = new WorkspaceManager();
  const srv = new McpServer({
    name: 'workspace-manager',
    version: '0.1.0',
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const t = srv.tool.bind(srv) as any;

  // workspace_list
  t(
    'workspace_list',
    'List all available workspaces. Shows current active workspace and all available options.',
    {},
    async () => {
      const current = manager.getCurrent();
      const all = manager.list();

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            current: current.name,
            workspaces: all.map(w => ({
              name: w.name,
              inputPath: w.inputPath,
              outputPath: w.outputPath,
              description: w.description,
              active: w.name === current.name,
            })),
          }),
        }],
      };
    },
  );

  // workspace_switch
  t(
    'workspace_switch',
    'Switch to a different workspace. Updates the active workspace globally.',
    {
      name: z.string().describe('Workspace name to switch to'),
    },
    async ({ name }: { name: string }) => {
      const result = manager.switch(name);

      if (!result.success) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: false,
              error: result.error,
              available: manager.list().map(w => w.name),
            }),
          }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: true,
            workspace: result.workspace,
            message: `Switched to workspace: ${name}`,
          }),
        }],
      };
    },
  );

  // workspace_current
  t(
    'workspace_current',
    'Get details of the currently active workspace.',
    {},
    async () => {
      const current = manager.getCurrent();

      if (!current.workspace) {
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'No workspace selected',
              available: manager.list().map(w => w.name),
            }),
          }],
        };
      }

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            name: current.name,
            workspace: current.workspace,
          }),
        }],
      };
    },
  );

  // workspace_add
  t(
    'workspace_add',
    'Add a new workspace or update an existing one.',
    {
      name: z.string().describe('Workspace name (unique identifier)'),
      inputPath: z.string().describe('Input directory path for curation'),
      outputPath: z.string().describe('Output vault path'),
      description: z.string().optional().describe('Human-readable description'),
    },
    async ({ name, inputPath, outputPath, description }: any) => {
      const existing = manager.list().find(w => w.name === name);

      if (existing) {
        const result = manager.update(name, { inputPath, outputPath, description });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              success: result.success,
              action: 'updated',
              workspace: result.workspace,
              error: result.error,
            }),
          }],
        };
      }

      const result = manager.add({ name, inputPath, outputPath, description });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: result.success,
            action: 'created',
            workspace: { name, inputPath, outputPath, description },
            error: result.error,
          }),
        }],
      };
    },
  );

  // workspace_remove
  t(
    'workspace_remove',
    'Remove a workspace from the configuration.',
    {
      name: z.string().describe('Workspace name to remove'),
    },
    async ({ name }: { name: string }) => {
      const result = manager.remove(name);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            success: result.success,
            removed: name,
            error: result.error,
            remaining: manager.list().map(w => w.name),
          }),
        }],
      };
    },
  );

  // Connect and run
  const transport = new StdioServerTransport();
  await srv.connect(transport);

  console.error('[workspace-manager] ✓ MCP server running on stdio');
  console.error('[workspace-manager] Ready for connections');
}

main().catch(err => {
  console.error(`[workspace-manager] ✗ Fatal: ${(err as Error).message}`);
  process.exit(1);
});
