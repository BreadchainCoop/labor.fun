# Open-source inference mode (NEAR AI)

labor.fun ships two inference modes:

| Mode                           | Backend                     | Provider                                         | Anthropic in path? | TEE           |
| ------------------------------ | --------------------------- | ------------------------------------------------ | ------------------ | ------------- |
| **Hosted Anthropic** (default) | `claude`                    | Anthropic Claude via the credential proxy        | Yes                | No            |
| **Open-source / TEE**          | `local` (OpenAI-compatible) | NEAR AI Cloud, or any OpenAI-compatible endpoint | **No**             | Yes (NEAR AI) |

The open-source mode runs agent turns against an **OpenAI-compatible** chat-completions endpoint instead of the Claude Agent SDK. Point it at [NEAR AI Cloud](https://cloud.near.ai/) and you get a fully **worker-owned, open-model, TEE-attested** stack with **no Anthropic dependency anywhere in the inference path** — the intended inference layer for the product's TEE mode. It also works with any local/self-hosted OpenAI-compatible server (LM Studio, llama.cpp `server`, vLLM, Ollama in OpenAI mode).

Hosted Anthropic remains the **default** and is unchanged. You opt into open-source mode explicitly (env below); nothing about the Claude path changes unless you do.

## What NEAR AI gives you

NEAR AI Cloud serves open-weight models (Llama, Qwen, DeepSeek, Mixtral, …) inside an **Intel TDX + NVIDIA confidential-GPU enclave**. Data stays encrypted _in use_, not just at rest and in transit, and every response is backed by a verifiable hardware quote binding the exact code and weights that served it. The API is OpenAI-compatible, so labor.fun's existing OpenAI-compatible backend drives it directly.

- **Base URL:** `https://cloud-api.near.ai/v1`
- **Auth:** `Authorization: Bearer <NEAR_AI_API_KEY>` (standard OpenAI-style key; get one at https://cloud.near.ai/)
- **Models:** `provider/model` identifiers, e.g. `deepseek-ai/DeepSeek-V3.1`, `Qwen/...`, `meta-llama/...`. List the live catalog with `GET https://cloud-api.near.ai/v1/models`.
- **Attestation:** queryable — `GET https://cloud-api.near.ai/v1/attestation/report?model=<model>&signing_algo=ecdsa&nonce=<hex>` returns `{ signing_address, nvidia_payload, intel_quote }`. See [NEAR AI verification docs](https://docs.near.ai/cloud/verification/).

## Enabling it

### The easy way — NEAR AI convenience

Set one variable:

```bash
NEAR_AI_API_KEY=<your NEAR AI Cloud key>
```

That alone flips the default backend to `local` and points it at NEAR AI Cloud:
`OPENAI_BASE_URL` → `https://cloud-api.near.ai/v1`, the key is used as the Bearer token, and the model defaults to `deepseek-ai/DeepSeek-V3.1`. Override the model with:

```bash
NEAR_AI_MODEL=Qwen/Qwen3-235B-A22B      # any model from GET /v1/models
```

An explicit `NANOCLAW_BACKEND` (or explicit `LOCAL_LLM_*`) **always wins** over the NEAR AI convenience, so `NANOCLAW_BACKEND=claude` keeps hosted Anthropic even with a NEAR AI key present.

### The explicit way — generic OpenAI-compatible

For a self-hosted or non-NEAR endpoint, drive the `local` backend directly:

```bash
NANOCLAW_BACKEND=local
LOCAL_LLM_BASE_URL=http://host.docker.internal:1234/v1   # your endpoint
LOCAL_LLM_MODEL=qwen2.5-coder-32b-instruct               # optional
LOCAL_LLM_API_KEY=<key>                                  # optional
```

## Env matrix & precedence

One backend per process — switch by restarting.

| Var                        | Applies to | Default                                                                | Notes                                                                             |
| -------------------------- | ---------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `NANOCLAW_BACKEND`         | selection  | `claude` (or `local` if `NEAR_AI_API_KEY` set)                         | `claude` \| `local`. Explicit value wins over the NEAR AI convenience.            |
| `NEAR_AI_API_KEY`          | NEAR AI    | —                                                                      | Secret. Setting it (without an explicit backend) selects `local` + NEAR AI Cloud. |
| `NEAR_AI_MODEL`            | NEAR AI    | `deepseek-ai/DeepSeek-V3.1`                                            | Any model from the NEAR AI catalog.                                               |
| `NEAR_AI_BASE_URL`         | NEAR AI    | `https://cloud-api.near.ai/v1`                                         | Escape hatch (e.g. a regional/proxy URL).                                         |
| `LOCAL_LLM_BASE_URL`       | local      | `http://host.docker.internal:1234/v1` (or NEAR AI URL in NEAR AI mode) | The endpoint the backend actually calls.                                          |
| `LOCAL_LLM_MODEL`          | local      | — (NEAR AI default in NEAR AI mode)                                    | Model id sent in each request.                                                    |
| `LOCAL_LLM_API_KEY`        | local      | — (NEAR AI key in NEAR AI mode)                                        | Secret. Bearer token.                                                             |
| `LOCAL_LLM_MAX_ITERATIONS` | local      | `20`                                                                   | Tool-call loop cap inside the container.                                          |

**Resolution order** for every var: `process.env` → install `.env` → NEAR AI convenience default (only when `NEAR_AI_MODE`) → hardcoded default. `NEAR_AI_MODE` is on when `NEAR_AI_API_KEY` is set **and** `NANOCLAW_BACKEND` is not explicitly set. Explicit `LOCAL_LLM_*` override the NEAR AI-derived values, so you can, e.g., keep a NEAR AI key but pin `LOCAL_LLM_MODEL`.

### Credential handling

The API key is a secret and flows exactly like the other container secrets: it is **never placed in argv** or the container-args debug log. `buildContainerArgs` adds a bare `-e LOCAL_LLM_API_KEY` passthrough flag, and `runContainerAgent` injects the value into the spawned runtime's process env only (Docker). This is the same mechanism the GitHub PAT uses. In `local` mode the credential proxy is **not started** — there is no Anthropic traffic to proxy; the container talks straight to `LOCAL_LLM_BASE_URL`.

## Attestation surface

`src/inference-attestation.ts` exposes the provider/verification surface a `!verify`-style flow can call:

- `getInferenceProviderInfo()` — static, no network: which provider is active (`anthropic` \| `near-ai` \| `openai-compatible`), whether it's TEE-backed and open-source, the model, and the base URL.
- `fetchNearAiAttestation()` — fetches the live NEAR AI hardware quote (`GET /attestation/report`, ECDSA, random nonce). Returns `{ signing_address, nvidia_payload, intel_quote }` or `undefined` on error.
- `getInferenceVerification()` — one call combining both: static info plus a live attestation report when the provider exposes one. Never throws; degrades to static info.

For hosted Anthropic and generic OpenAI-compatible endpoints there is no standard attestation endpoint, so these return static provider info only (documented in the module). The NEAR AI key is sent only as the Bearer header on the attestation request; no secret is logged or returned.

## Limitations vs hosted Claude

Open-source mode trades some fidelity for a fully open, verifiable stack:

- **Tool-use fidelity.** The `local` backend runs its own OpenAI tool-calling loop (`container/agent-runner/src/backends/local.ts`) with a hard iteration cap. Open models vary in tool-call reliability; an endpoint that rejects the tools schema (HTTP 400) falls back to tool-less completion for the rest of the session.
- **No Claude-specific skills / SDK features.** No PreCompact transcript archiving, no Claude subagent/agent-teams orchestration, no session resume — those are Claude Agent SDK features. Skills are surfaced as **prompt context only** (`backends/skill-shim.ts`), not as directly invocable tools.
- **MCP coverage.** The local backend bridges **stdio** MCP servers (nanoclaw IPC, `gws`, GitHub). Linear's official server is **HTTP-only**, so it is available on the `claude` backend (native SDK HTTP MCP) but skipped in `local` mode. The generic remote-MCP bridge and Linear over HTTP remain claude-only for now.
- **Non-streamed, single-model.** v1 uses non-streamed completions and one model for both orchestrator and subagent roles.

For maximum tool-use fidelity and the full skill/MCP surface, use the default hosted-Anthropic mode. For a worker-owned, open-weight, TEE-attested, no-Anthropic stack, use NEAR AI.

## Lineage

This mode revives and specializes the OpenAI-compatible backend first prototyped on the `RonTuretzky/local-llm-mode` branch (`container/agent-runner/src/backends/`, the `runtime.ts` refactor, and the `NANOCLAW_BACKEND` / `LOCAL_LLM_*` wiring). The NEAR AI convenience layer, attestation helper, and this doc are the specialization on top.
