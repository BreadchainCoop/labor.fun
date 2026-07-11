import fs from 'fs';
import path from 'path';

import {
  query,
  HookCallback,
  PreCompactHookInput,
} from '@anthropic-ai/claude-agent-sdk';

import {
  drainIpcInput,
  IPC_POLL_MS,
  log,
  MessageStream,
  shouldClose,
  writeOutput,
} from '../runtime.js';
import { buildDynamicMcpServers } from '../mcp-servers.js';
import { Backend, RunQueryArgs, RunQueryResult } from './types.js';

interface SessionEntry {
  sessionId: string;
  fullPath: string;
  summary: string;
  firstPrompt: string;
}

interface SessionsIndex {
  entries: SessionEntry[];
}

interface ParsedMessage {
  role: 'user' | 'assistant';
  content: string;
}

function getSessionSummary(
  sessionId: string,
  transcriptPath: string,
): string | null {
  const projectDir = path.dirname(transcriptPath);
  const indexPath = path.join(projectDir, 'sessions-index.json');

  if (!fs.existsSync(indexPath)) {
    log(`Sessions index not found at ${indexPath}`);
    return null;
  }

  try {
    const index: SessionsIndex = JSON.parse(
      fs.readFileSync(indexPath, 'utf-8'),
    );
    const entry = index.entries.find((e) => e.sessionId === sessionId);
    if (entry?.summary) {
      return entry.summary;
    }
  } catch (err) {
    log(
      `Failed to read sessions index: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return null;
}

function sanitizeFilename(summary: string): string {
  return summary
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

function generateFallbackName(): string {
  const time = new Date();
  return `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
}

function parseTranscript(content: string): ParsedMessage[] {
  const messages: ParsedMessage[] = [];

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' && entry.message?.content) {
        const text =
          typeof entry.message.content === 'string'
            ? entry.message.content
            : entry.message.content
                .map((c: { text?: string }) => c.text || '')
                .join('');
        if (text) messages.push({ role: 'user', content: text });
      } else if (entry.type === 'assistant' && entry.message?.content) {
        const textParts = entry.message.content
          .filter((c: { type: string }) => c.type === 'text')
          .map((c: { text: string }) => c.text);
        const text = textParts.join('');
        if (text) messages.push({ role: 'assistant', content: text });
      }
    } catch {
      /* ignore non-JSON lines */
    }
  }

  return messages;
}

function formatTranscriptMarkdown(
  messages: ParsedMessage[],
  title?: string | null,
  assistantName?: string,
): string {
  const now = new Date();
  const formatDateTime = (d: Date) =>
    d.toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

  const lines: string[] = [];
  lines.push(`# ${title || 'Conversation'}`);
  lines.push('');
  lines.push(`Archived: ${formatDateTime(now)}`);
  lines.push('');
  lines.push('---');
  lines.push('');

  for (const msg of messages) {
    const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
    const content =
      msg.content.length > 2000
        ? msg.content.slice(0, 2000) + '...'
        : msg.content;
    lines.push(`**${sender}**: ${content}`);
    lines.push('');
  }

  return lines.join('\n');
}

function createPreCompactHook(assistantName?: string): HookCallback {
  return async (input, _toolUseId, _context) => {
    const preCompact = input as PreCompactHookInput;
    const transcriptPath = preCompact.transcript_path;
    const sessionId = preCompact.session_id;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
      log('No transcript found for archiving');
      return {};
    }

    try {
      const content = fs.readFileSync(transcriptPath, 'utf-8');
      const messages = parseTranscript(content);

      if (messages.length === 0) {
        log('No messages to archive');
        return {};
      }

      const summary = getSessionSummary(sessionId, transcriptPath);
      const name = summary ? sanitizeFilename(summary) : generateFallbackName();

      const conversationsDir = '/workspace/group/conversations';
      fs.mkdirSync(conversationsDir, { recursive: true });

      const date = new Date().toISOString().split('T')[0];
      const filename = `${date}-${name}.md`;
      const filePath = path.join(conversationsDir, filename);

      const markdown = formatTranscriptMarkdown(
        messages,
        summary,
        assistantName,
      );
      fs.writeFileSync(filePath, markdown);

      log(`Archived conversation to ${filePath}`);
    } catch (err) {
      log(
        `Failed to archive transcript: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    return {};
  };
}

export class ClaudeBackend implements Backend {
  async runQuery(args: RunQueryArgs): Promise<RunQueryResult> {
    const {
      prompt,
      sessionId,
      resumeAt,
      mcpServerPath,
      containerInput,
      sdkEnv,
      hasGoogleWorkspace,
      hasGithub,
      hasLinear,
    } = args;

    const stream = new MessageStream();
    stream.push(prompt);

    // Poll IPC for follow-up messages and _close sentinel during the query
    let ipcPolling = true;
    let closedDuringQuery = false;
    const pollIpcDuringQuery = () => {
      if (!ipcPolling) return;
      if (shouldClose()) {
        log('Close sentinel detected during query, ending stream');
        closedDuringQuery = true;
        stream.end();
        ipcPolling = false;
        return;
      }
      const messages = drainIpcInput();
      for (const text of messages) {
        log(`Piping IPC message into active query (${text.length} chars)`);
        stream.push(text);
      }
      setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
    };
    setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

    let newSessionId: string | undefined;
    let lastAssistantUuid: string | undefined;
    let messageCount = 0;
    let resultCount = 0;

    // Load global CLAUDE.md as additional system context (shared across all groups)
    const globalClaudeMdPath = '/workspace/global/CLAUDE.md';
    let globalClaudeMd: string | undefined;
    if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
      globalClaudeMd = fs.readFileSync(globalClaudeMdPath, 'utf-8');
    }
    // Combine the global memory with any per-run system-prompt append (e.g. the
    // membership-intake persona). The append goes last so it takes precedence.
    const systemPromptAppend =
      [globalClaudeMd, containerInput.systemPromptAppend]
        .filter((s): s is string => Boolean(s))
        .join('\n\n') || undefined;

    // Discover additional directories mounted at /workspace/extra/*
    const extraDirs: string[] = [];
    const extraBase = '/workspace/extra';
    if (fs.existsSync(extraBase)) {
      for (const entry of fs.readdirSync(extraBase)) {
        const fullPath = path.join(extraBase, entry);
        if (fs.statSync(fullPath).isDirectory()) {
          extraDirs.push(fullPath);
        }
      }
    }
    if (extraDirs.length > 0) {
      log(`Additional directories: ${extraDirs.join(', ')}`);
    }

    // Model routing: NANOCLAW_MODEL for orchestrator, NANOCLAW_SUBAGENT_MODEL for sub-agents
    const orchestratorModel = process.env.NANOCLAW_MODEL || undefined;
    if (orchestratorModel) {
      log(`Model: ${orchestratorModel}`);
    }

    // Generic remote-MCP bridge: assemble config-driven MCP servers (Zapier,
    // Jira, Stripe, Notion, stdio tools, …) from ContainerInput.mcpServers and
    // the container's env. Each enabled entry yields an SDK `mcpServers` entry
    // plus an `mcp__<name>__*` allowlist token. Entries whose referenced env
    // vars are unset are silently omitted (same gating as hasLinear). Only
    // non-secret metadata (names/count) is logged, never header/env values.
    const dynamicMcp = buildDynamicMcpServers(
      containerInput.mcpServers,
      process.env,
    );
    const dynamicMcpNames = Object.keys(dynamicMcp.mcpServers);
    if (dynamicMcpNames.length > 0) {
      log(`Config-driven MCP servers: ${dynamicMcpNames.join(', ')}`);
    }

    for await (const message of query({
      prompt: stream,
      options: {
        cwd: '/workspace/group',
        model: orchestratorModel,
        additionalDirectories: extraDirs.length > 0 ? extraDirs : undefined,
        resume: sessionId,
        resumeSessionAt: resumeAt,
        systemPrompt: systemPromptAppend
          ? {
              type: 'preset' as const,
              preset: 'claude_code' as const,
              append: systemPromptAppend,
            }
          : undefined,
        // A restricted allowlist (e.g. the sandboxed membership-intake flow)
        // replaces the default tool set entirely.
        allowedTools: containerInput.allowedTools ?? [
          'Bash',
          'Read',
          'Write',
          'Edit',
          'Glob',
          'Grep',
          'WebSearch',
          'WebFetch',
          'Task',
          'TaskOutput',
          'TaskStop',
          'TeamCreate',
          'TeamDelete',
          'SendMessage',
          'TodoWrite',
          'ToolSearch',
          'Skill',
          'NotebookEdit',
          'mcp__nanoclaw__*',
          ...(hasGoogleWorkspace ? ['mcp__gws__*'] : []),
          ...(hasGithub ? ['mcp__github__*'] : []),
          ...(hasLinear ? ['mcp__linear__*'] : []),
          // Config-driven MCP servers (generic remote-MCP bridge).
          ...dynamicMcp.allowedToolTokens,
        ],
        env: sdkEnv,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        settingSources: ['project', 'user'],
        mcpServers: {
          nanoclaw: {
            command: 'node',
            args: [mcpServerPath],
            env: {
              NANOCLAW_CHAT_JID: containerInput.chatJid,
              NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
              NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
            },
          },
          ...(hasGoogleWorkspace
            ? {
                gws: {
                  command: 'gws',
                  // --tool-mode compact: gws would otherwise expose ~214 raw
                  // Google API tools, flooding the agent's context. Compact mode
                  // collapses them to one tool per service plus a `gws_discover`
                  // meta-tool (~26 total); the agent drills in on demand.
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
                },
              }
            : {}),
          ...(hasGithub
            ? {
                github: {
                  command: 'github-mcp-server',
                  // read+write; toolsets scoped to code/issues/PRs/CI/Projects V2.
                  // Repo scope is enforced by the PAT, not the server.
                  args: [
                    'stdio',
                    '--toolsets',
                    'context,repos,issues,pull_requests,actions,projects',
                  ],
                  env: {
                    GITHUB_PERSONAL_ACCESS_TOKEN:
                      process.env.GITHUB_PERSONAL_ACCESS_TOKEN!,
                  },
                },
              }
            : {}),
          ...(hasLinear
            ? {
                linear: {
                  // Linear's official hosted MCP server. It accepts a personal
                  // API key via the Authorization: Bearer header (no OAuth flow),
                  // so no local package or browser auth is needed. Connected over
                  // streamable HTTP; the key never appears in argv.
                  type: 'http' as const,
                  url: 'https://mcp.linear.app/mcp',
                  headers: {
                    Authorization: `Bearer ${process.env.LINEAR_API_KEY!}`,
                  },
                },
              }
            : {}),
          // Config-driven MCP servers (generic remote-MCP bridge). Each enabled
          // entry (its referenced env vars are all set) is spread in here as a
          // streamable-HTTP or stdio server. Built from ContainerInput.mcpServers
          // + the container's env by buildDynamicMcpServers. See docs/MCP-SERVERS.md.
          ...dynamicMcp.mcpServers,
        },
        hooks: {
          PreCompact: [
            { hooks: [createPreCompactHook(containerInput.assistantName)] },
          ],
        },
      },
    })) {
      messageCount++;
      const msgType =
        message.type === 'system'
          ? `system/${(message as { subtype?: string }).subtype}`
          : message.type;
      log(`[msg #${messageCount}] type=${msgType}`);

      if (message.type === 'assistant' && 'uuid' in message) {
        lastAssistantUuid = (message as { uuid: string }).uuid;
      }

      if (message.type === 'system' && message.subtype === 'init') {
        newSessionId = message.session_id;
        log(`Session initialized: ${newSessionId}`);
      }

      if (
        message.type === 'system' &&
        (message as { subtype?: string }).subtype === 'task_notification'
      ) {
        const tn = message as {
          task_id: string;
          status: string;
          summary: string;
        };
        log(
          `Task notification: task=${tn.task_id} status=${tn.status} summary=${tn.summary}`,
        );
      }

      if (message.type === 'result') {
        resultCount++;
        const textResult =
          'result' in message ? (message as { result?: string }).result : null;
        log(
          `Result #${resultCount}: subtype=${message.subtype}${textResult ? ` text=${textResult.slice(0, 200)}` : ''}`,
        );
        writeOutput({
          status: 'success',
          result: textResult || null,
          newSessionId,
        });
      }
    }

    ipcPolling = false;
    log(
      `Query done. Messages: ${messageCount}, results: ${resultCount}, lastAssistantUuid: ${lastAssistantUuid || 'none'}, closedDuringQuery: ${closedDuringQuery}`,
    );
    return { newSessionId, lastAssistantUuid, closedDuringQuery };
  }
}
