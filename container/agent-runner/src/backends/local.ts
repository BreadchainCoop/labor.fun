/**
 * Local-LLM backend: drives an OpenAI-compatible chat-completions endpoint
 * (LM Studio, llama.cpp server, vLLM, Ollama in OpenAI mode, etc).
 *
 * One runQuery() call processes a single user turn end-to-end:
 *   1. POST /chat/completions with current messages[] + tools[]
 *   2. If response has tool_calls -> dispatch via McpBridge -> append tool
 *      messages -> iterate
 *   3. Otherwise -> writeOutput(success, text) -> return
 *
 * Cross-turn conversation history is persisted in `this.history` so subsequent
 * runQuery calls (driven by main()'s outer loop on each new IPC user message)
 * preserve context. The MCP bridge is started lazily on first use and reused
 * across turns within a container lifetime.
 *
 * v1 simplifications (documented in the plan): non-streamed completions,
 * no session resume, hard iteration cap to bound runaway tool loops.
 */

import crypto from 'crypto';
import fs from 'fs';

import { drainIpcInput, log, shouldClose, writeOutput } from '../runtime.js';
import { McpBridge, OpenAITool } from './mcp-bridge.js';
import { buildSkillsContext } from './skill-shim.js';
import { Backend, RunQueryArgs, RunQueryResult } from './types.js';

const MAX_ITERATIONS = (() => {
  const raw = process.env.LOCAL_LLM_MAX_ITERATIONS;
  const n = raw ? parseInt(raw, 10) : 20;
  return Number.isFinite(n) && n > 0 ? n : 20;
})();

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface ChatChoice {
  index: number;
  message: {
    role: 'assistant';
    content: string | null;
    tool_calls?: ToolCall[];
  };
  finish_reason: string;
}

interface ChatResponse {
  id: string;
  choices: ChatChoice[];
}

function buildSystemPrompt(args: RunQueryArgs): string {
  const parts: string[] = [];

  parts.push(
    `You are ${args.containerInput.assistantName || 'Breadbrich Engels'}, a multi-channel assistant running in local-LLM mode against a Breadbrich Engels container. You have access to a set of MCP tools (listed in the tools parameter) for interacting with the knowledge base, sending messages, scheduling tasks, and integrating with external systems. Prefer tool calls over speculation when a tool is available.`,
  );
  parts.push('');

  // Per-group memory (CLAUDE.md) — same file the Claude SDK consumes
  const groupClaudeMd = '/workspace/group/CLAUDE.md';
  if (fs.existsSync(groupClaudeMd)) {
    try {
      const content = fs.readFileSync(groupClaudeMd, 'utf-8');
      parts.push('## Group memory (CLAUDE.md)');
      parts.push('');
      parts.push(content);
      parts.push('');
    } catch (err) {
      log(
        `[local-backend] Failed to read group CLAUDE.md: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Global org context (only mounted for non-main groups)
  const globalClaudeMd = '/workspace/global/CLAUDE.md';
  if (!args.containerInput.isMain && fs.existsSync(globalClaudeMd)) {
    try {
      const content = fs.readFileSync(globalClaudeMd, 'utf-8');
      parts.push('## Global organization context');
      parts.push('');
      parts.push(content);
      parts.push('');
    } catch {
      /* ignore */
    }
  }

  const skillsCtx = buildSkillsContext();
  if (skillsCtx) {
    parts.push(skillsCtx);
  }

  return parts.join('\n');
}

async function callChatCompletions(
  baseUrl: string,
  apiKey: string | undefined,
  model: string,
  messages: ChatMessage[],
  tools: OpenAITool[],
  useTools: boolean,
): Promise<ChatResponse> {
  const url = `${baseUrl.replace(/\/$/, '')}/chat/completions`;
  const body: Record<string, unknown> = {
    model,
    messages,
    stream: false,
  };
  if (useTools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = 'auto';
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(
      `chat/completions HTTP ${res.status}: ${text.slice(0, 500)}`,
    );
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }

  return (await res.json()) as ChatResponse;
}

export class LocalBackend implements Backend {
  private bridge: McpBridge | null = null;
  private toolsRejected = false;
  private history: ChatMessage[] = [];
  private sessionId: string | null = null;

  async runQuery(args: RunQueryArgs): Promise<RunQueryResult> {
    const baseUrl =
      process.env.LOCAL_LLM_BASE_URL || 'http://host.docker.internal:1234/v1';
    const model = process.env.LOCAL_LLM_MODEL || 'local-model';
    const apiKey = process.env.LOCAL_LLM_API_KEY || undefined;

    if (!this.bridge) {
      this.bridge = await McpBridge.start({
        mcpServerPath: args.mcpServerPath,
        chatJid: args.containerInput.chatJid,
        groupFolder: args.containerInput.groupFolder,
        isMain: args.containerInput.isMain,
        hasGoogleCalendar: args.hasGoogleCalendar,
        hasGithub: args.hasGithub,
      });
    }

    if (!this.sessionId) {
      this.sessionId = args.sessionId || crypto.randomUUID();
    }

    if (this.history.length === 0) {
      this.history.push({ role: 'system', content: buildSystemPrompt(args) });
    }
    this.history.push({ role: 'user', content: args.prompt });

    const tools = this.bridge.listTools();
    log(
      `[local-backend] Starting turn (model=${model}, tools=${tools.length}, base=${baseUrl}, history=${this.history.length})`,
    );

    let iterations = 0;
    let closedDuringQuery = false;
    try {
      while (true) {
        // Check for close sentinel between iterations. Mirrors the Claude
        // backend's pollIpcDuringQuery loop — without this, a mid-turn close
        // request would only be picked up on the next idle wait, reintroducing
        // the idle-timeout delay the sentinel is meant to avoid.
        if (shouldClose()) {
          log('[local-backend] Close sentinel detected mid-turn, aborting');
          closedDuringQuery = true;
          break;
        }
        // Drain any follow-up user messages that arrived mid-turn and fold
        // them into history so the next model call sees them.
        const followUps = drainIpcInput();
        for (const text of followUps) {
          log(
            `[local-backend] Appending follow-up IPC message (${text.length} chars)`,
          );
          this.history.push({ role: 'user', content: text });
        }

        if (iterations >= MAX_ITERATIONS) {
          log(
            `[local-backend] Iteration cap (${MAX_ITERATIONS}) exceeded, aborting turn`,
          );
          writeOutput({
            status: 'error',
            result: null,
            newSessionId: this.sessionId,
            error: `iteration cap exceeded (${MAX_ITERATIONS})`,
          });
          break;
        }
        iterations++;

        let response: ChatResponse;
        try {
          response = await callChatCompletions(
            baseUrl,
            apiKey,
            model,
            this.history,
            tools,
            !this.toolsRejected,
          );
        } catch (err) {
          const status = (err as Error & { status?: number }).status;
          if (status === 400 && !this.toolsRejected && tools.length > 0) {
            log(
              `[local-backend] Endpoint rejected tools schema (HTTP 400). Retrying without tools for the rest of the run.`,
            );
            this.toolsRejected = true;
            iterations--; // retry doesn't count
            continue;
          }
          throw err;
        }

        const choice = response.choices[0];
        if (!choice) {
          throw new Error('Endpoint returned no choices');
        }

        const assistantMsg = choice.message;
        const hasToolCalls =
          !!assistantMsg.tool_calls && assistantMsg.tool_calls.length > 0;
        // Always append the assistant turn before dispatching or yielding —
        // otherwise the model loses its own context on the next iteration.
        // OpenAI-compatible schemas expect `content: null` on tool-call turns
        // (some servers reject a non-null/empty string alongside tool_calls).
        this.history.push({
          role: 'assistant',
          content: hasToolCalls ? null : (assistantMsg.content ?? ''),
          tool_calls: assistantMsg.tool_calls,
        });

        if (hasToolCalls) {
          for (const call of assistantMsg.tool_calls!) {
            if (shouldClose()) {
              log(
                '[local-backend] Close sentinel detected during tool dispatch, aborting',
              );
              closedDuringQuery = true;
              break;
            }

            let parsedArgs: Record<string, unknown> = {};
            try {
              parsedArgs = call.function.arguments
                ? JSON.parse(call.function.arguments)
                : {};
            } catch (err) {
              const errMsg = `Could not parse arguments JSON: ${err instanceof Error ? err.message : String(err)}. Raw: ${call.function.arguments?.slice(0, 200)}`;
              log(`[local-backend] ${errMsg}`);
              this.history.push({
                role: 'tool',
                tool_call_id: call.id,
                name: call.function.name,
                content: JSON.stringify({ error: errMsg }),
              });
              continue;
            }

            log(
              `[mcp-bridge] dispatching ${call.function.name} (${Object.keys(parsedArgs).length} args)`,
            );
            const result = await this.bridge.dispatch(
              call.function.name,
              parsedArgs,
            );
            this.history.push({
              role: 'tool',
              tool_call_id: call.id,
              name: call.function.name,
              content: result,
            });
          }
          if (closedDuringQuery) break;
          // Iterate: model needs to see the tool results.
          continue;
        }

        // Plain text turn — emit and exit. Main() will wait for the next user
        // message and call runQuery again with it.
        const text = assistantMsg.content ?? '';
        log(
          `[local-backend] Turn complete (iterations=${iterations}, chars=${text.length})`,
        );
        writeOutput({
          status: 'success',
          result: text || null,
          newSessionId: this.sessionId,
        });
        break;
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      log(`[local-backend] Error: ${errorMessage}`);
      writeOutput({
        status: 'error',
        result: null,
        newSessionId: this.sessionId,
        error: errorMessage,
      });
    }

    return {
      newSessionId: this.sessionId,
      lastAssistantUuid: undefined,
      closedDuringQuery,
    };
  }
}
