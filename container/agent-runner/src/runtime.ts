/**
 * Shared runtime infrastructure used by both backends (claude, local) and main().
 *
 * Encapsulates:
 *   - stdout marker protocol (writeOutput, log)
 *   - IPC input directory polling (drainIpcInput, shouldClose, waitForIpcMessage)
 *   - MessageStream: push-based async iterable used to stream user turns into the agent loop
 *
 * Keeping these here lets backends import them without depending on index.ts (which would
 * be a circular import) and lets index.ts and the backends agree on the same wire format.
 */

import fs from 'fs';
import path from 'path';

import type { McpServerConfig } from './mcp-servers.js';

export interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  script?: string;
  /** Restrict the agent to exactly these tools (sandboxed flows). */
  allowedTools?: string[];
  /** Extra system-prompt text appended after the global memory. */
  systemPromptAppend?: string;
  /**
   * Config-driven MCP servers (generic remote-MCP bridge). NON-SECRET shape
   * only — name/type/url/command/args + env var NAMES; the referenced secret
   * VALUES arrive via the container's process env (docker `-e NAME` / k8s pod
   * env). Each enabled entry becomes an SDK `mcpServers` entry + an
   * `mcp__<name>__*` allowlist token. See docs/MCP-SERVERS.md.
   */
  mcpServers?: McpServerConfig[];
}

export interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export interface SDKUserMessage {
  type: 'user';
  message: { role: 'user'; content: string };
  parent_tool_use_id: null;
  session_id: string;
}

export const IPC_INPUT_DIR = '/workspace/ipc/input';
export const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
export const IPC_POLL_MS = 500;

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

export function writeOutput(output: ContainerOutput): void {
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
}

export function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

/**
 * Push-based async iterable for streaming user messages into the agent loop.
 * Keeps the iterable alive until end() is called.
 */
export class MessageStream {
  private queue: SDKUserMessage[] = [];
  private waiting: (() => void) | null = null;
  private done = false;

  push(text: string): void {
    this.queue.push({
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
      session_id: '',
    });
    this.waiting?.();
  }

  end(): void {
    this.done = true;
    this.waiting?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage> {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((r) => {
        this.waiting = r;
      });
      this.waiting = null;
    }
  }
}

export function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try {
      fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
    } catch {
      /* ignore */
    }
    return true;
  }
  return false;
}

export function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs
      .readdirSync(IPC_INPUT_DIR)
      .filter((f) => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(
          `Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`,
        );
        try {
          fs.unlinkSync(filePath);
        } catch {
          /* ignore */
        }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

export function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}
