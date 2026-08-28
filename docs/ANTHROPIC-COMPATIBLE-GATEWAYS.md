# Anthropic-compatible gateways (GLM / Z.ai)

The default `claude` backend can run against any API that speaks the Anthropic
Messages protocol. The full Agent SDK surface stays intact: skills, MCP servers,
streaming, session resume, agent teams.

| Option                     | Backend  | Inference served by            | SDK surface |
| -------------------------- | -------- | ------------------------------ | ----------- |
| Hosted Anthropic (default) | `claude` | Anthropic                      | Full        |
| Compatible gateway         | `claude` | Z.ai (GLM), or similar         | Full        |
| Open-source / TEE          | `local`  | NEAR AI, or any OpenAI-compat. | Reduced     |

The `local` backend is a different axis. See [OPEN-SOURCE-AI.md](OPEN-SOURCE-AI.md).

## Setup

### 1. Set three variables

Wherever this install sources `ANTHROPIC_API_KEY` from today (`.env`, or the
OneCLI vault):

```bash
ANTHROPIC_BASE_URL=https://api.z.ai/api/anthropic
ANTHROPIC_API_KEY=<your Z.ai key>
NANOCLAW_MODEL=glm-4.6
```

| Variable             | Effect                                                   |
| -------------------- | -------------------------------------------------------- |
| `ANTHROPIC_BASE_URL` | Redirects the proxy upstream and host-process calls.     |
| `ANTHROPIC_API_KEY`  | Its presence selects api-key mode. Required (see below). |
| `NANOCLAW_MODEL`     | Model id sent on every run. Use a current Z.ai model.    |

### 2. Clear any OAuth token

Unset `CLAUDE_CODE_OAUTH_TOKEN` and `ANTHROPIC_AUTH_TOKEN`. With an OAuth token
and no API key, the proxy selects OAuth mode and every run fails (see
"Auth mode" below).

### 3. Override the pricing table

`src/model-pricing.ts` matches model ids by substring and falls back to Sonnet
rates, so `glm-4.6` would be costed at Claude prices. Set the provider's real
per-MTok USD rates:

```bash
MODEL_PRICING_JSON={"glm":{"input":0.6,"output":2.2,"cacheWrite":0.6,"cacheRead":0.11}}
```

One `glm` entry covers every GLM variant. Usage capture is unaffected: the proxy
parses `usage.*` off `/v1/messages`, which compatible gateways return in the
Anthropic response shape.

### 4. Deploy and restart

No container rebuild is needed. The proxy upstream is read at process start.

```bash
/opt/breadbrich-backups/safe-deploy.sh
systemctl restart breadbrich
```

### 5. Verify

Trigger an agent run, then confirm the `api_usage` rows record a `glm-` model id
rather than a Claude one. Test translation separately: it exercises the
host-process path rather than the container path.

### Rollback

Unset `ANTHROPIC_BASE_URL`, restore the Anthropic key, restart. The code
defaults to Anthropic when the variable is absent.

## Why it needs almost no code

The credential proxy already resolves its upstream from `ANTHROPIC_BASE_URL`
(`startCredentialProxy` in `src/credential-proxy.ts`). Containers never see the
real key either way: they send a placeholder the proxy swaps for the live
credential.

Host-process callers (the pre-agent translation service) used a hardcoded
`https://api.anthropic.com`. They now resolve through `anthropicApiBase()` in
`src/anthropic-auth.ts`, which reads the same variable. Without it, a
third-party key works inside containers while every host-process call returns
401 against Anthropic.

## Auth mode: use `ANTHROPIC_API_KEY`

The proxy selects its auth mode by the presence of `ANTHROPIC_API_KEY`. With
only `ANTHROPIC_AUTH_TOKEN` or `CLAUDE_CODE_OAUTH_TOKEN` set, it enters OAuth
mode, where the container CLI calls Anthropic's
`POST /api/oauth/claude_cli/create_api_key` (`OAUTH_CREATE_API_KEY_PATH`). No
third-party gateway implements that endpoint. OAuth mode is Anthropic-only.

Z.ai's own Claude Code docs suggest `ANTHROPIC_AUTH_TOKEN` because the stock CLI
sends it as `Authorization: Bearer`. Their gateway also accepts `x-api-key`,
which is what the proxy injects, so `ANTHROPIC_API_KEY` is correct here.

## Verifying a gateway's auth scheme

Before adopting another gateway, confirm it reads `x-api-key`. Compare a bogus
key against a no-header control:

```bash
# Control: no auth header
curl -s https://api.z.ai/api/anthropic/v1/messages \
  -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
  -d '{"model":"glm-4.6","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}'

# x-api-key present but invalid
curl -s https://api.z.ai/api/anthropic/v1/messages \
  -H "x-api-key: sk-bogus" \
  -H "anthropic-version: 2023-06-01" -H "content-type: application/json" \
  -d '{"model":"glm-4.6","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}'
```

Observed against Z.ai:

| Header sent             | Response                                             | Read? |
| ----------------------- | ---------------------------------------------------- | ----- |
| none                    | `type 1001`, "Authentication parameter not received" | n/a   |
| `x-api-key`             | `type 401`, "token expired or incorrect"             | yes   |
| `Authorization: Bearer` | `type 401`, "token expired or incorrect"             | yes   |

Two different errors mean the header was read. An identical error for all three
means `x-api-key` is ignored and the gateway is Bearer-only, which needs a code
change in `anthropicAuthHeaders()`.

## Limits

- **Anthropic-only extras are pass-through.** Prompt caching,
  `/v1/messages/count_tokens`, `anthropic-beta` features and the server-side web
  search tool behave however the gateway implements them, if at all.
- **Model tiers name Claude.** `LABOR_TIER_CHEAP_MODEL` and
  `LABOR_TIER_STRONG_MODEL` default to Claude ids. Repoint them or leave the
  router unused.
- **Process-global.** `ANTHROPIC_BASE_URL` applies to the whole process. There is
  no per-request routing (see [SMITHERS-ORCHESTRATION.md](SMITHERS-ORCHESTRATION.md)).
- **No attestation.** Unlike the NEAR AI path, a commercial gateway offers no
  hardware attestation.
