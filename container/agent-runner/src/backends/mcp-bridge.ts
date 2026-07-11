/**
 * MCP bridge for the local-LLM backend.
 *
 * Spawns the same MCP servers that the Claude SDK would launch (nanoclaw,
 * google-calendar, github), connects via stdio, enumerates their tools, and
 * exposes them in OpenAI tool-call format. Dispatches model-issued tool_calls
 * back to the relevant MCP server via JSON-RPC.
 *
 * The bridge is intentionally bare-bones: no caching, no concurrency limits.
 * Conversations are short (one user/agent turn cycle) so children boot once
 * per container run and shut down on process exit.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { log } from '../runtime.js';

export interface OpenAITool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface ServerSpec {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface ConnectedServer {
  name: string;
  client: Client;
  toolNames: Set<string>;
}

export interface McpBridgeInit {
  mcpServerPath: string;
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
  hasGoogleWorkspace: boolean;
  hasGithub: boolean;
  hasLinear: boolean;
}

export class McpBridge {
  private servers: ConnectedServer[] = [];
  private toolToServer = new Map<string, { server: ConnectedServer; rawName: string }>();
  private tools: OpenAITool[] = [];

  static async start(init: McpBridgeInit): Promise<McpBridge> {
    const bridge = new McpBridge();

    const specs: ServerSpec[] = [
      {
        name: 'nanoclaw',
        command: 'node',
        args: [init.mcpServerPath],
        env: {
          NANOCLAW_CHAT_JID: init.chatJid,
          NANOCLAW_GROUP_FOLDER: init.groupFolder,
          NANOCLAW_IS_MAIN: init.isMain ? '1' : '0',
        },
      },
    ];

    if (init.hasGoogleWorkspace) {
      specs.push({
        name: 'gws',
        command: 'gws',
        // Compact tool-mode: collapse ~214 raw Google API tools to ~26 (one per
        // service + a gws_discover meta-tool). Matches the claude backend.
        args: [
          'mcp',
          '-s',
          'drive,gmail,calendar,docs,sheets,tasks',
          '--tool-mode',
          'compact',
        ],
        env: {
          GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE:
            process.env.GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE!,
        },
      });
    }

    // NOTE: Linear (init.hasLinear) is intentionally NOT bridged in local mode.
    // Its official MCP server is hosted over streamable HTTP (not a stdio
    // command), and this v1 bridge only spawns stdio MCP servers. The claude
    // backend still gets Linear via the SDK's native HTTP MCP transport.

    if (init.hasGithub) {
      specs.push({
        name: 'github',
        command: 'github-mcp-server',
        args: [
          'stdio',
          '--toolsets',
          'context,repos,issues,pull_requests,actions,projects',
        ],
        env: {
          GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_PERSONAL_ACCESS_TOKEN!,
        },
      });
    }

    for (const spec of specs) {
      try {
        await bridge.connect(spec);
      } catch (err) {
        log(
          `[mcp-bridge] Failed to start server "${spec.name}": ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    process.on('exit', () => bridge.shutdownSync());
    process.on('SIGINT', () => {
      bridge.shutdownSync();
      process.exit(0);
    });
    process.on('SIGTERM', () => {
      bridge.shutdownSync();
      process.exit(0);
    });

    log(
      `[mcp-bridge] Ready with ${bridge.tools.length} tools across ${bridge.servers.length} servers`,
    );
    return bridge;
  }

  private async connect(spec: ServerSpec): Promise<void> {
    const transport = new StdioClientTransport({
      command: spec.command,
      args: spec.args,
      env: { ...process.env, ...(spec.env || {}) } as Record<string, string>,
    });

    const client = new Client(
      { name: `nanoclaw-bridge-${spec.name}`, version: '1.0.0' },
      { capabilities: {} },
    );

    await client.connect(transport);

    const listed = await client.listTools();
    const toolNames = new Set<string>();
    for (const tool of listed.tools) {
      const openaiName = `mcp__${spec.name}__${tool.name}`;
      toolNames.add(tool.name);

      // MCP inputSchema is already JSON Schema; OpenAI tools accept the same.
      // Fall back to a permissive empty-object schema for tools with no params.
      const parameters =
        (tool.inputSchema as Record<string, unknown> | undefined) || {
          type: 'object',
          properties: {},
        };

      this.tools.push({
        type: 'function',
        function: {
          name: openaiName,
          description: tool.description || `${spec.name} tool: ${tool.name}`,
          parameters,
        },
      });
    }

    const connected: ConnectedServer = { name: spec.name, client, toolNames };
    this.servers.push(connected);

    for (const toolName of toolNames) {
      this.toolToServer.set(`mcp__${spec.name}__${toolName}`, {
        server: connected,
        rawName: toolName,
      });
    }

    log(`[mcp-bridge] Connected to "${spec.name}" (${toolNames.size} tools)`);
  }

  listTools(): OpenAITool[] {
    return this.tools;
  }

  async dispatch(name: string, args: Record<string, unknown>): Promise<string> {
    const entry = this.toolToServer.get(name);
    if (!entry) {
      return JSON.stringify({ error: `Unknown tool: ${name}` });
    }

    try {
      const result = await entry.server.client.callTool({
        name: entry.rawName,
        arguments: args,
      });

      // Flatten content[] to a single string the model can consume.
      const content = (result as { content?: Array<{ type: string; text?: string }> })
        .content;
      if (!content || content.length === 0) {
        return '';
      }
      return content
        .map((c) => (c.type === 'text' ? c.text || '' : JSON.stringify(c)))
        .join('\n');
    } catch (err) {
      log(
        `[mcp-bridge] tool call "${name}" failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return JSON.stringify({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private shutdownSync(): void {
    for (const server of this.servers) {
      try {
        // Client.close() is async but we're in a sync exit handler; fire-and-forget.
        void server.client.close();
      } catch {
        /* ignore */
      }
    }
  }

  async shutdown(): Promise<void> {
    await Promise.all(
      this.servers.map(async (s) => {
        try {
          await s.client.close();
        } catch {
          /* ignore */
        }
      }),
    );
    this.servers = [];
    this.toolToServer.clear();
    this.tools = [];
  }
}
