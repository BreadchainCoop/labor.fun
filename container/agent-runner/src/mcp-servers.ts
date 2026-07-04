/**
 * Container-side half of the generic remote-MCP bridge (docs/MCP-SERVERS.md).
 *
 * The host resolves the configured MCP servers (profile.config.json /
 * MCP_SERVERS), passes the NON-SECRET shape (name/type/url/command/args + env
 * var NAMES) into the container via ContainerInput.mcpServers, and threads the
 * referenced secret VALUES through the container's process environment (docker
 * `-e NAME` passthrough / kubernetes resolved pod env — see
 * src/container-runner.ts). This module turns that config + the container's own
 * env into the SDK `mcpServers` map entries and the `mcp__<name>__*` tool
 * allowlist tokens.
 *
 * Pure (no fs/stdin/query side effects) so index.ts can import it and it stays
 * unit-testable. Types mirror src/mcp-servers.ts on the host side — the two
 * builds don't share an import path across the container boundary, so keep the
 * shapes in sync by hand.
 */

export interface McpServerHttpConfig {
  name: string;
  type: 'http';
  url: string;
  bearerEnvVar?: string;
  headerEnvVars?: Record<string, string>;
}

export interface McpServerStdioConfig {
  name: string;
  type: 'stdio';
  command: string;
  args?: string[];
  envVars?: string[];
}

export type McpServerConfig = McpServerHttpConfig | McpServerStdioConfig;

/**
 * Shape of one SDK `mcpServers` entry we build. Kept structural (not tied to
 * the SDK's exported type) so this module needs no SDK import and stays a pure
 * data transform; index.ts spreads the result into the `mcpServers` map.
 */
export type BuiltMcpServer =
  | {
      type: 'http';
      url: string;
      headers?: Record<string, string>;
    }
  | {
      command: string;
      args?: string[];
      env?: Record<string, string>;
    };

export interface BuiltMcpServers {
  /** Object to spread into the SDK `mcpServers` map, keyed by server name. */
  mcpServers: Record<string, BuiltMcpServer>;
  /** `mcp__<name>__*` allowlist tokens for the servers that were enabled. */
  allowedToolTokens: string[];
}

/**
 * Build the SDK `mcpServers` entries + allowlist tokens for the configured
 * servers, given the container's env. A server is ENABLED (included) only when
 * every env var it references is present:
 *
 *   http:  if `bearerEnvVar`/`headerEnvVars` are set, all referenced vars must
 *          be present; a server that references NO env var (public/no-auth) is
 *          always enabled.
 *   stdio: every name in `envVars` must be present; empty/unset → always
 *          enabled (a local tool needing no secret).
 *
 * A server missing a required var is simply omitted (no entry, no tool token) —
 * mirroring the `hasLinear` gating. No secret VALUE is ever returned in a
 * loggable position beyond the SDK entry itself (headers/env) which the caller
 * hands to the SDK, never logs.
 */
export function buildDynamicMcpServers(
  configs: McpServerConfig[] | undefined,
  env: Record<string, string | undefined>,
): BuiltMcpServers {
  const mcpServers: Record<string, BuiltMcpServer> = {};
  const allowedToolTokens: string[] = [];

  for (const cfg of configs ?? []) {
    if (cfg.type === 'http') {
      const referenced: string[] = [];
      if (cfg.bearerEnvVar) referenced.push(cfg.bearerEnvVar);
      if (cfg.headerEnvVars) referenced.push(...Object.values(cfg.headerEnvVars));

      // Gate: every referenced var must resolve to a non-empty value.
      const allPresent = referenced.every((name) => Boolean(env[name]));
      if (!allPresent) continue;

      const headers: Record<string, string> = {};
      if (cfg.headerEnvVars) {
        for (const [header, envName] of Object.entries(cfg.headerEnvVars)) {
          headers[header] = env[envName] as string;
        }
      }
      if (cfg.bearerEnvVar) {
        headers.Authorization = `Bearer ${env[cfg.bearerEnvVar] as string}`;
      }

      mcpServers[cfg.name] = {
        type: 'http',
        url: cfg.url,
        ...(Object.keys(headers).length ? { headers } : {}),
      };
      allowedToolTokens.push(`mcp__${cfg.name}__*`);
    } else {
      const referenced = cfg.envVars ?? [];
      const allPresent = referenced.every((name) => Boolean(env[name]));
      if (!allPresent) continue;

      const serverEnv: Record<string, string> = {};
      for (const name of referenced) {
        serverEnv[name] = env[name] as string;
      }

      mcpServers[cfg.name] = {
        command: cfg.command,
        ...(cfg.args ? { args: cfg.args } : {}),
        ...(referenced.length ? { env: serverEnv } : {}),
      };
      allowedToolTokens.push(`mcp__${cfg.name}__*`);
    }
  }

  return { mcpServers, allowedToolTokens };
}
