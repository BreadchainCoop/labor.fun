# Generic Remote-MCP Bridge

An org can wire **any** MCP server — a hosted remote endpoint (streamable
HTTP + Bearer/header auth) or a local stdio tool — into every agent container
with **config only**, no framework code changes. This is how you add Zapier
(30k+ actions across 9k apps), Jira, Confluence, Stripe, Notion, PagerDuty, or
any other MCP-speaking service.

It complements the built-in, hardcoded MCP servers (`nanoclaw`, `gws`,
`github`, `linear` — wired directly in
`container/agent-runner/src/index.ts`), which keep working unchanged. Those
names are reserved and cannot be reused by a config-driven entry.

## Config schema

Add entries to `mcpServers` in the active profile's `profile.config.json`
(`ProfileConfig.mcpServers`, typed in `src/profile.ts`), and/or the
`MCP_SERVERS` env var (a JSON array, useful for hosted/multi-tenant installs
that inject servers without editing profile files — read in `src/config.ts`).
Both sources are merged (profile entries first, then `MCP_SERVERS`) and
validated together by `validateMcpServerConfigs` (`src/mcp-servers.ts`), which
throws loudly on a bad shape rather than silently dropping the entry.

Two entry shapes:

```ts
// Remote / HTTP (streamable-HTTP MCP endpoint)
{
  name: string;              // /^[a-z0-9_-]+$/ — object key + mcp__<name>__* allowlist token
  type: 'http';
  url: string;               // e.g. https://mcp.zapier.com/api/mcp/<id>/sse
  bearerEnvVar?: string;     // env var NAME whose value → `Authorization: Bearer <value>`
  headerEnvVars?: Record<string, string>; // { "X-Header": "ENV_VAR_NAME" }
}

// Local / stdio (a command the container spawns and speaks MCP to over stdio)
{
  name: string;              // same rules as above
  type: 'stdio';
  command: string;           // must be present in the container image/PATH
  args?: string[];
  envVars?: string[];        // env var NAMES to pass through to the process
}
```

Rules, enforced at startup:

- `name` must match `/^[a-z0-9_-]+$/` and must not collide with a reserved
  built-in name (`RESERVED_MCP_SERVER_NAMES` in `src/mcp-servers.ts`:
  `nanoclaw`, `gws`, `github`, `linear`) or another configured entry.
- **Secret values never appear in config** — only the *names* of env vars to
  read at request time (`bearerEnvVar`, `headerEnvVars` values, `envVars`).
  The actual secret values live in `.env` / the deploy environment, same as
  `LINEAR_API_KEY` / `GITHUB_PERSONAL_ACCESS_TOKEN` today.
- A server whose referenced env var(s) are **not all set** is simply omitted
  — no `mcpServers` entry, no `mcp__<name>__*` allowlist token — mirroring the
  existing `hasLinear` gating. A server that references no env var at all
  (public/no-auth) is always enabled.
- Setting nothing (`mcpServers` unset, `MCP_SERVERS` unset) is a no-op: zero
  behavior change from before this feature existed.

## How config reaches the container (end to end)

1. **Startup / config load** — `src/config.ts` merges the active profile's
   `mcpServers` with the `MCP_SERVERS` env var (JSON array), validates the
   combined list via `validateMcpServerConfigs`, and exports the typed result
   as `MCP_SERVERS: McpServerConfig[]`.
2. **Container spawn** — every call site that spawns an agent container
   (`src/index.ts` for live messages, `src/task-scheduler.ts` for scheduled
   tasks, `src/integrations/pm-orchestration.ts` for PM nudges) passes
   `mcpServers: MCP_SERVERS` into the `ContainerInput` it builds. As a
   belt-and-suspenders default, `runContainerAgent` in `src/container-runner.ts`
   also injects `input.mcpServers ?? MCP_SERVERS` itself, so no call site can
   forget it.
3. **Stdin-JSON payload** — `runContainerAgent` serializes the whole
   `ContainerInput` (including `mcpServers`, containing only the **non-secret**
   shape — name/type/url/command/args + env var *names*) and writes it to the
   spawned process's stdin: `container.stdin.write(JSON.stringify(input))`.
4. **Env plumbing (secret values)** — the env var **values** referenced by the
   configured servers travel separately, through the container's process
   environment, resolved by `getMcpServerEnvVars()` in `container-runner.ts`
   (reads `.env` via `readEnvFile`, falls back to `process.env` — same pattern
   as `getGithubToken()` / `getLinearApiKey()`):
   - **Docker**: `buildContainerArgs` passes each resolved var through by
     **name only** (`-e NAME`, no `=value` in argv), and `runContainerAgent`
     sets the actual value in the spawned process's env (`extraEnv`).
   - **Kubernetes**: `buildK8sEnvVars` embeds each resolved `{name, value}`
     pair directly into the pod spec's `env` list (there's no name-only
     passthrough for `kubectl run --overrides`). `redactSecretsInArgs` then
     scrubs every one of those values out of the debug-logged argv before it's
     written anywhere, the same way it already redacts the GitHub PAT and
     Linear API key.
5. **Agent-runner reads stdin** — `container/agent-runner/src/index.ts` parses
   the stdin JSON into `containerInput` (`containerInput.mcpServers`) and calls
   `buildDynamicMcpServers(containerInput.mcpServers, process.env)`
   (`container/agent-runner/src/mcp-servers.ts` — a pure, dependency-free
   module with its own copy of the config types, since the container build
   doesn't share an import path with the host). For each entry whose
   referenced env var(s) resolve to a non-empty value in the container's own
   env, it builds:
   - an SDK `mcpServers` entry (`{ type: 'http', url, headers }` for HTTP,
     `{ command, args, env }` for stdio), and
   - an `mcp__<name>__*` allowlist token.
6. **Wired into the SDK query** — `runQuery` spreads
   `...dynamicMcp.mcpServers` into the SDK's `mcpServers` map (alongside the
   hardcoded `nanoclaw`/`gws`/`github`/`linear` entries) and
   `...dynamicMcp.allowedToolTokens` into `allowedTools`, so the agent can call
   the new server's tools in that run.

## Worked example: Zapier

Zapier's hosted MCP server exposes actions across 9,000+ apps through Zaps you
expose as "Actions." It's a streamable-HTTP MCP server authenticated with a
Bearer token.

1. Create a Zapier MCP endpoint (Zapier dashboard → MCP → create a server,
   expose the Actions you want) and copy its URL and the Bearer token it gives
   you.
2. Add the token to `.env` (never commit it):

   ```bash
   ZAPIER_MCP_TOKEN=sk-...
   ```

3. Add the server to the active profile's `profile.config.json`:

   ```json
   {
     "mcpServers": [
       {
         "name": "zapier",
         "type": "http",
         "url": "https://mcp.zapier.com/api/mcp/<your-id>/sse",
         "bearerEnvVar": "ZAPIER_MCP_TOKEN"
       }
     ]
   }
   ```

   (Equivalently, for a hosted/multi-tenant install, set
   `MCP_SERVERS='[{"name":"zapier","type":"http","url":"https://mcp.zapier.com/api/mcp/<your-id>/sse","bearerEnvVar":"ZAPIER_MCP_TOKEN"}]'`
   instead of editing the profile file.)

4. Deploy (`push → merge → deploy`, per this repo's deployment rule — the env
   var itself can be added directly on the host without a code deploy, since
   `.env` is gitignored runtime state).

Once `ZAPIER_MCP_TOKEN` is set, every agent container gets a `zapier` entry in
its `mcpServers` map and `mcp__zapier__*` in its tool allowlist, and the agent
can call any Action you exposed on that Zapier MCP server. If the token is
ever unset, the server is silently omitted — no framework change needed to
disable it.

The same recipe (`type: "http"`, a `url`, and a `bearerEnvVar` or
`headerEnvVars`) works for other official remote MCP servers, e.g. Jira/
Confluence, Stripe, Notion, or PagerDuty — swap the `url` and the env var
name(s) their auth scheme expects.

## Worked example: a local/stdio tool

For an MCP server distributed as a CLI package rather than a hosted endpoint:

```json
{
  "mcpServers": [
    {
      "name": "my-tool",
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@some-org/some-mcp-server"],
      "envVars": ["SOME_TOOL_API_KEY"]
    }
  ]
}
```

`command` must be resolvable inside the agent container image (on `PATH`, or
bundled by `container/build.sh` if it's not already there). `envVars` lists
the names of env vars the *server process* needs — same gating as the HTTP
case: the server is only wired in once every named var is set.

## Testing

- `src/mcp-servers.test.ts` — config validation (good/bad names, reserved
  names, duplicate names, http vs. stdio shape checks) and env-var-name
  collection.
- `container/agent-runner/src/mcp-servers.test.ts` — assembly of the SDK
  `mcpServers` map + allowlist tokens from a config + a fake `env`, including
  the "referenced env var missing → server omitted" gating for both transport
  types.
- `src/container-runner.test.ts` / `src/container-runner-k8s.test.ts` —
  end-to-end env plumbing: referenced env vars appear as `-e NAME` in the
  docker args and as resolved `{name, value}` pairs in the k8s pod spec, secret
  values are redacted from logged argv, and the configured servers land in the
  stdin-JSON payload written to the container process.
