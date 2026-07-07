/**
 * Generic remote-MCP bridge: validation + env-var accounting for the
 * config-driven MCP servers an org declares in `profile.config.json`
 * (`mcpServers`) or the `MCP_SERVERS` env var. See docs/MCP-SERVERS.md.
 *
 * This module is pure (no fs/env/child_process access) so it can be reused by
 * config.ts (parse + validate at startup), container-runner.ts (which env vars
 * to thread through / redact), and unit tests, without side effects. The
 * container-side agent-runner has its own copy of the *types* (different build,
 * no shared import path across the container boundary) — keep the shapes in
 * sync with container/agent-runner/src/mcp-servers.ts.
 */
import type {
  McpServerConfig,
  McpServerHttpConfig,
  McpServerStdioConfig,
} from './profile.js';

export type {
  McpServerConfig,
  McpServerHttpConfig,
  McpServerStdioConfig,
} from './profile.js';

/** Name must be a safe object key + `mcp__<name>__*` allowlist token. */
const NAME_RE = /^[a-z0-9_-]+$/;

/**
 * Built-in MCP server names an org must NOT reuse — they'd collide with the
 * always-on / hardcoded servers wired in agent-runner/src/index.ts.
 */
export const RESERVED_MCP_SERVER_NAMES = new Set([
  'nanoclaw',
  'gws',
  'github',
  'linear',
]);

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * Validate a raw (unknown-shaped) list of MCP server configs. Returns the
 * typed list on success; THROWS a descriptive Error on the first invalid entry
 * (loud failure at config-load / startup time, never a silent drop). Accepts
 * undefined/null/empty → [].
 */
export function validateMcpServerConfigs(configs: unknown): McpServerConfig[] {
  if (configs == null) return [];
  if (!Array.isArray(configs)) {
    throw new Error(
      `mcpServers must be an array, got ${typeof configs}. See docs/MCP-SERVERS.md.`,
    );
  }

  const seen = new Set<string>();
  const out: McpServerConfig[] = [];

  for (let i = 0; i < configs.length; i++) {
    const raw = configs[i];
    const where = `mcpServers[${i}]`;
    if (typeof raw !== 'object' || raw === null) {
      throw new Error(`${where} must be an object.`);
    }
    const entry = raw as Record<string, unknown>;

    const name = entry.name;
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      throw new Error(
        `${where}.name must match /^[a-z0-9_-]+$/ (lowercase letters, digits, ` +
          `dash, underscore) — got ${JSON.stringify(name)}. It is used as an ` +
          `object key and the mcp__<name>__* tool-allowlist token.`,
      );
    }
    if (RESERVED_MCP_SERVER_NAMES.has(name)) {
      throw new Error(
        `${where}.name "${name}" is a reserved built-in MCP server name ` +
          `(${[...RESERVED_MCP_SERVER_NAMES].join(', ')}). Choose another name.`,
      );
    }
    if (seen.has(name)) {
      throw new Error(`Duplicate mcpServers name "${name}" (at ${where}).`);
    }
    seen.add(name);

    const type = entry.type;
    if (type === 'http') {
      if (typeof entry.url !== 'string' || entry.url.trim() === '') {
        throw new Error(`${where} (http) requires a non-empty "url" string.`);
      }
      if (
        entry.bearerEnvVar !== undefined &&
        typeof entry.bearerEnvVar !== 'string'
      ) {
        throw new Error(`${where}.bearerEnvVar must be a string if present.`);
      }
      if (entry.headerEnvVars !== undefined) {
        const h = entry.headerEnvVars;
        if (typeof h !== 'object' || h === null || Array.isArray(h)) {
          throw new Error(
            `${where}.headerEnvVars must be an object of {Header: ENV_VAR_NAME}.`,
          );
        }
        for (const [k, v] of Object.entries(h as Record<string, unknown>)) {
          if (typeof v !== 'string') {
            throw new Error(
              `${where}.headerEnvVars["${k}"] must be a string (an env var name).`,
            );
          }
        }
      }
      out.push({
        name,
        type: 'http',
        url: entry.url,
        ...(entry.bearerEnvVar
          ? { bearerEnvVar: entry.bearerEnvVar as string }
          : {}),
        ...(entry.headerEnvVars
          ? { headerEnvVars: entry.headerEnvVars as Record<string, string> }
          : {}),
      } satisfies McpServerHttpConfig);
    } else if (type === 'stdio') {
      if (typeof entry.command !== 'string' || entry.command.trim() === '') {
        throw new Error(
          `${where} (stdio) requires a non-empty "command" string.`,
        );
      }
      if (entry.args !== undefined && !isStringArray(entry.args)) {
        throw new Error(
          `${where}.args must be an array of strings if present.`,
        );
      }
      if (entry.envVars !== undefined && !isStringArray(entry.envVars)) {
        throw new Error(
          `${where}.envVars must be an array of strings (env var names) if present.`,
        );
      }
      out.push({
        name,
        type: 'stdio',
        command: entry.command,
        ...(entry.args ? { args: entry.args as string[] } : {}),
        ...(entry.envVars ? { envVars: entry.envVars as string[] } : {}),
      } satisfies McpServerStdioConfig);
    } else {
      throw new Error(
        `${where}.type must be "http" or "stdio", got ${JSON.stringify(type)}.`,
      );
    }
  }

  return out;
}

/**
 * Every env var NAME referenced across the given servers (bearerEnvVar +
 * headerEnvVars values + stdio envVars), deduped and sorted. This is the list
 * that drives both runtimes' secret env plumbing (docker `-e NAME` passthrough,
 * kubernetes resolved pod env) and log redaction in container-runner.ts.
 */
export function mcpServerEnvVarNames(servers: McpServerConfig[]): string[] {
  const names = new Set<string>();
  for (const s of servers) {
    if (s.type === 'http') {
      if (s.bearerEnvVar) names.add(s.bearerEnvVar);
      if (s.headerEnvVars) {
        for (const v of Object.values(s.headerEnvVars)) names.add(v);
      }
    } else {
      for (const v of s.envVars ?? []) names.add(v);
    }
  }
  return [...names].sort();
}
