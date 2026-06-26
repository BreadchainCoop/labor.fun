# orchestration/ — durable Smithers workflows

Isolated [Smithers](https://smithers.sh) sidecar that runs **multi-step agent
workflows as durable, checkpointed graphs**, while keeping every step inside
labor.fun's container sandbox. This directory is **not** part of the `src/`
TypeScript build — it runs on Bun as its own process.

See [`docs/SMITHERS-ORCHESTRATION.md`](../docs/SMITHERS-ORCHESTRATION.md) for the
full architecture and rationale.

## Why it's shaped this way

Smithers' built-in agents call the model API directly. We never use them.
Instead each `<Task>` runs through a **`ContainerAgent`** that delegates to
`runContainerAgent()`, so steps keep the Docker sandbox, per-group memory,
credential proxy, and RBAC. Smithers contributes the durable step graph,
checkpointing (SQLite), and per-step model routing.

```
Smithers <Task>  ─▶  ContainerAgent  ─▶  runContainerAgent  ─▶  Docker(group) ─▶ model
   model tier ↑ chosen by model-router.ts (NANOCLAW_MODEL per-run override)
```

## Files

| File | Role |
|------|------|
| `model-router.ts` | **The brain.** Tier registry (cheap/default/strong), step→tier map, escalation ladder. The single local-inference seam. |
| `agents/container-agent.ts` | `ContainerAgent extends BaseAgent` — bridges a Smithers task to `runContainerAgent`. |
| `runtime.ts` | Binds the abstract `RunStep` port to the real container runner (in-process or over IPC). |
| `workflows/transcript.tsx` | Pilot (Pattern A): transcript → KB items → HTML summary, with per-step model escalation. |
| `workflows/expense.tsx` | Pilot (Pattern B): human-in-the-loop approval chain with `needsApproval` gates. |
| `workflows/meeting-scheduling.tsx` | Calendar-aware scheduling: parallel free/busy reads → timezone match → pre-proposed slots → approval → book. |

## Plugging in local inference (the whole point)

Edit **one** entry in `model-router.ts`:

```ts
cheap: {
  model: process.env.LOCAL_MODEL ?? 'llama-3.3-70b',
  baseUrl: process.env.LOCAL_INFERENCE_URL, // e.g. http://host.docker.internal:11434
  label: 'cheap',
},
```

No workflow changes. Cheap/bulk steps run locally; anything that fails its Zod
schema escalates to `strong` (Claude) automatically via the fallback chain.

> Per-step `baseUrl` routing needs one more enabling change in the container
> runner (route the credential-proxy upstream by model, or add a `baseUrlOverride`
> sibling to the `modelOverride` field already added to `ContainerInput`).
> Per-step **model** selection works today.

## Verify-on-install

Before relying on this, run `bun install` here, then `bunx smithers-orchestrator
init`, and confirm against the installed package:

- `BaseAgent` constructor + `run()` signature (in `agents/container-agent.ts`)
- `createSmithers` / `Sequence` / `<Task>` prop names (in `workflows/transcript.tsx`)

These are written to the documented API; pin them to the real types once installed.

## Status

**Transcript pilot validated on remote (#110).** The durable graph runs
end-to-end through `runContainerAgent`: parse → extract → reconcile checkpoint to
SQLite and the run resumes from the last completed step (a reconcile retry
continued without re-running parse/extract). Per-step model tiers
(haiku/sonnet/opus) apply via `modelOverride`.

The verify-on-install items are resolved and pinned to `smithers-orchestrator@0.25`:
- A Smithers agent is the structural `AgentLike` (a `generate()` method), **not** a
  `BaseAgent` to extend — see `agents/container-agent.ts`.
- Schemas must be **Zod v4** (`package.json`).
- The bridge must terminate each step's container itself (`docker kill` by name)
  and allow long steps (fetch + http.Server timeouts) — see `src/index.ts`,
  `src/smithers-bridge.ts`, and `runtime.ts`.

Enable on a host via `orchestration/deploy/README.md` (Bun + `bun install`,
`SMITHERS_BRIDGE_ENABLED`, restart). Still off by default; the orchestrator is
unaffected until the bridge is enabled.
