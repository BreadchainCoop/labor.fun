# Smithers orchestration (durable workflows + model routing)

Status: **design + scaffold.** Not wired into the running orchestrator yet.
Code lives in [`orchestration/`](../orchestration/README.md). Tracking branch:
`RonTuretzky/local-llm-plugin-uses`.

## Goal

Run labor.fun's **multi-step agent workflows** (transcript processing, weekly
agenda, PM orchestration, approval chains) as **durable, checkpointed graphs**
so a crash mid-workflow resumes instead of restarting — and so each step can run
on the model best suited to it. Build it **future-proof for local inference**:
the model decision is centralized so that pointing bulk steps at a local model
is a one-line change, with automatic **escalation** back to Claude when a cheap
model isn't good enough.

We use [Smithers](https://smithers.sh) (`smithers-orchestrator`, MIT) for the
durable runtime: TSX workflows, SQLite checkpoints, `resume`/`rewind`/`fork`,
Zod-validated step outputs, and per-task agent selection.

## The core constraint that shapes everything

Smithers' built-in agents (`AnthropicAgent`, `OpenAIAgent`) **call the model API
directly.** If a workflow used them, every step would bypass the things that
make this framework valuable per group:

- the Docker sandbox and volume mounts (`buildVolumeMounts`)
- per-group memory / KB isolation
- the credential proxy (`src/credential-proxy.ts`) — containers never see secrets
- RBAC / identity resolution (`src/permissions.ts`)

**Therefore: Smithers never runs the model. It runs _containers_.** Every
`<Task>` is executed by a `ContainerAgent` that delegates to
`runContainerAgent()`. Smithers contributes the layer _above_ the container:
the durable step graph, checkpointing, and model routing.

```
 Smithers <Task agent={chain}>
        │  run(messages)
        ▼
 ContainerAgent (orchestration/agents/container-agent.ts)
        │  runStep({ group, prompt, modelOverride, ... })
        ▼
 runContainerAgent()  ── Docker(group) ── Claude Agent SDK ── credential proxy ── model
        ▲
        └─ modelOverride = the step's ModelSpec.model  (per-run NANOCLAW_MODEL)
```

## Components

| Piece | File | Responsibility |
|-------|------|----------------|
| Model router | `orchestration/model-router.ts` | Tiers (cheap/default/strong), step→tier map, escalation ladder, **local-inference seam** |
| Container bridge | `orchestration/agents/container-agent.ts` | `ContainerAgent extends BaseAgent`; runs a step in the group's container at a chosen model |
| Runtime binding | `orchestration/runtime.ts` | Wires the abstract `RunStep` port to `runContainerAgent` (in-process or over IPC) |
| Pilot workflow | `orchestration/workflows/transcript.tsx` | transcript → KB items → HTML summary, as a checkpointed Sequence |
| Enabling change | `src/container-runner.ts` | `ContainerInput.modelOverride` → `buildContainerArgs` → `NANOCLAW_MODEL` per run |

### The enabling change (already made)

`runContainerAgent` injected a **global** `NANOCLAW_MODEL` into every container.
Per-step routing needs a per-run override, so `ContainerInput` gained an optional
`modelOverride`, threaded into `buildContainerArgs`:

```ts
const orchestratorModel = modelOverride || NANOCLAW_MODEL; // override wins, else global
```

Additive and backward-compatible: unset `modelOverride` = exactly today's
behavior. This is the only `src/` change required for per-step **model**
selection.

## How "which model + escalation" works

The router is the single decision point. Workflows ask for a *task kind*, never a
model.

```
TIERS:   cheap → claude-haiku   default → claude-sonnet   strong → claude-opus
TASK_TIER:   parse=cheap  extract=default  reconcile=strong  render=cheap
NEXT_TIER:   cheap → strong     default → strong     strong → ∅
```

`chainFor(kind)` returns `[baseTier, ...escalations]`. The workflow wraps each in
a `ContainerAgent` and hands Smithers `agent={[primary, fallback]}`. Smithers
runs `primary`; if its output **fails the step's Zod schema** (or a scorer
rejects it), `ContainerAgent.run` throws and Smithers **falls through to the next
agent** — i.e. escalates to a stronger model. No bespoke escalation code; it's
the fallback-chain + schema-validation primitives doing the work.

The "smithers skill" (installed by `bunx smithers-orchestrator init`) is what
lets the **agent itself** author/launch/resume these workflows from chat ("smithers,
process this transcript") rather than us hand-running the CLI.

## Plugging in local inference

This is the design's payoff. To route bulk steps at a local model, edit **one**
`TIERS` entry in `model-router.ts`:

```ts
cheap: {
  model: process.env.LOCAL_MODEL ?? 'llama-3.3-70b',
  baseUrl: process.env.LOCAL_INFERENCE_URL, // http://host.docker.internal:11434
  label: 'cheap',
},
```

Now `parse` and `render` run locally; if a local result fails validation it
escalates to `strong` (Claude) automatically. **No workflow file changes.**

Two enabling steps remain for the `baseUrl` half (model id already works):

1. **Per-step endpoint.** `ANTHROPIC_BASE_URL` is currently fixed to the
   credential proxy. Either (a) teach the proxy to route upstream by model id
   (local models → local server, `claude-*` → Anthropic), or (b) add a
   `baseUrlOverride` field to `ContainerInput` mirroring `modelOverride`. (a) is
   cleaner — keeps the one-chokepoint property.
2. **Anthropic-shaped local server.** The local server must speak the
   `/v1/messages` request/response shape (llama.cpp server, vLLM + adapter, or
   Ollama behind an Anthropic-compat shim). Precedent: `use-local-whisper`
   already swaps a cloud API for a local binary; `add-ollama-tool` already
   reaches a local Ollama from inside the container.

Until then, the existing `add-ollama-tool` path gives **local inference as a
tool** today, with zero orchestration changes — the cheapest way to start
measuring local-model quality on real sub-tasks.

## Two patterns, and where each applies

Surveying the repo, every good Smithers candidate is one of two shapes. They
exercise *different* Smithers features, so the two pilots
(`workflows/transcript.tsx`, `workflows/expense.tsx`) demonstrate one each.

**Pattern A — single-run, internally multi-step, with escalation.** One agent
invocation today that does several stages in sequence. Smithers adds
checkpoint/resume (crash mid-stage resumes) and per-step model routing +
escalation. _Transcript processing, weekly-agenda build, SD draft generation,
the PM brief._

**Pattern B — long-lived, human-in-the-loop state machine.** A multi-actor chain
that pauses for human approval and resumes (often days later) when a *different*
person acts. Today these are scattered IPC handlers + `expenses` /
`proposed_tasks` DB state. Smithers expresses the whole chain as one durable,
inspectable graph with explicit `needsApproval` gates. The privileged side still
owns the actual DB transition and the tier/identity checks — the workflow only
sequences the gates. _Expense approval, meeting-task approval, peer-review cycle._

### Candidate catalog (ranked by fit)

| # | Candidate | Pattern | Source | Why it fits |
|---|-----------|---------|--------|-------------|
| 1 | **Expense approval** | B | `src/ipc.ts:1997-2318` | Multi-person approval gates, tier limits ($500 coordinator / admin), DB-durable — textbook `needsApproval`. **Scaffolded.** |
| 2 | **Meeting-task approval (+ calendar scheduling)** | A+B | `src/ipc.ts:1681-1991` | Propose → human approves each → KB write. Robustified with parallel free/busy reads, timezone matching, and pre-proposed slots. **Scaffolded** (`workflows/meeting-scheduling.tsx`). |
| 3 | **Transcript processing** | A | `container/skills/transcript-processor` | Parse→extract→reconcile→render; crash loses all progress; bulk steps cheap. **Scaffolded (pilot).** |
| 4 | **Weekly-agenda build + nudge** | A+B | `profiles/example/plugins/weekly-agenda.mjs`, `container/skills/weekly-agenda` | Multi-week lifecycle, self-healing build retry, parallel owner nudges that escalate to channel. |
| 5 | **Peer-review cycle** | B | `profiles/example/plugins/peer-reviews.mjs` | Quarter-long; nudge→escalate ladder; optional calendar-matching fan-out branch. |
| 6 | **SD kickoff + draft** | A+B | `profiles/example/plugins/sd-kickoff.mjs` | Committee input fan-out, deadline fallback, draft generation step. |
| 7 | **PM orchestration loop** | A | `src/integrations/pm-orchestration.ts` | Deterministic brief enables retry; partial progress (some DMs sent) lost today; cooldown table. |
| 8 | **GitHub project sync** | — | `src/integrations/github-project-sync.ts` | Fragile reconcile-after-partial-write; Smithers checkpointing would make the delete pass safe. |
| 9 | **Discord members sync** | — | `src/integrations/discord-members-sync.ts` | Idempotent batch; low fit (no gates), but checkpointing avoids full re-sync. |

Low/no fit (single-step, already atomic): membership-intake chat flow, admin-email
scheduling coordinator, group-digest snapshot. Don't bother.

**Sequencing recommendation:** transcript first (Pattern A, lowest blast radius —
read-mostly, no money), then expense (Pattern B, highest value but touches the
approval authority path, so do it second once the bridge is proven). Everything
else reuses one of those two templates.

## Deployment

- The Smithers sidecar runs on **Bun**, separate from the Node orchestrator.
  Keep it **out of the hot path**: it processes the long, async workflows
  (transcripts, agendas), not the live message loop.
- Honor the framework's hard rule: **push → merge → deploy.** The sidecar is a
  new service unit; add it to `safe-deploy.sh` only after the pilot validates.
- `orchestration/` is excluded from the `src/` build (`tsconfig include:
  ["src/**/*"]`), so it cannot break `npm run build` / the running service.

## Remote environment requirements

What the droplet needs before any of this *runs* there. None of it ships with
the current orchestrator, so the initial migration PR adds code only — these are
the follow-up infra tasks (tracked as backlog issues).

**Runtime & deps**
- **Bun** installed on the host (the orchestrator is Node; the Smithers sidecar
  is Bun). `cd orchestration && bun install` (`smithers-orchestrator`, `zod`).
- A **Smithers state dir** for the SQLite checkpoint DB — must be persistent and
  **gitignored**, alongside `profiles/<org>/store/` (so runs survive restarts).
- A **systemd unit** (e.g. `breadbrich-smithers`) for the sidecar, added to
  `safe-deploy.sh`; honor push → merge → deploy.

**Wiring the sidecar to the container runner** (`orchestration/runtime.ts`)
- Option A (in-process): the sidecar imports the built runner — it must run as a
  user that can spawn Docker containers and reach the same DB/state as the
  orchestrator.
- Option B (over IPC/HTTP, preferred for prod): add a small authenticated
  "run step" endpoint to the orchestrator that calls `runContainerAgent` and
  returns the result. Keeps the sidecar decoupled; nothing else in `src/` moves.

**Approval bridge** (Pattern B — expense, meeting-task)
- A hook from the chat IPC layer (where `expense_decision` /
  `approve_proposed_tasks` are handled today) into Smithers' approve/resume API,
  keyed by run id. **Tier limits, identity resolution, and self-approval blocks
  stay on the privileged side** — the workflow only sequences gates. This is the
  "safe API integration" the expense backlog issue covers.

**Calendar (meeting-scheduling workflow only)**
- A **google-calendar MCP server wired into the agent container**, with
  per-group OAuth injected via the credential vault (containers never see real
  tokens — same proxy discipline as the model API).
- Each participant's **timezone in `context/people/<slug>.md` frontmatter**
  (the availability step reads it). Add to the people-file schema + Discord/KB
  sync if missing.

**Local inference (future, optional)**
- `LOCAL_INFERENCE_URL` + a local server speaking the Anthropic `/v1/messages`
  shape, and per-tier `baseUrl` routing in the credential proxy (route by model
  id). Until then, per-step **model** routing works; per-step **endpoint** does
  not. `LABOR_TIER_{CHEAP,DEFAULT,STRONG}_MODEL` env vars override tier models.

**Secrets** — no new app secrets for the Claude path (reuses the existing proxy).
Calendar OAuth and any local-inference endpoint are the only additions, both via
the vault, never committed.

## Pilot plan

1. `cd orchestration && bun install && bunx smithers-orchestrator init`.
2. **Verify-on-install**: pin `BaseAgent.run` signature and `createSmithers`/
   `<Task>` prop names to the installed package (flagged in both files).
3. Wire `runtime.ts` → `runContainerAgent` (start with in-process binding A).
4. Run `transcript.tsx` against a real meeting transcript; confirm checkpoint +
   `--resume` after a forced crash.
5. Flip `cheap` tier to a local model; confirm escalation fires when the local
   output fails the Zod schema.
6. If quality holds, expand to `weekly-agenda` and the PM-orchestration flow.

## Why not just swap `ANTHROPIC_BASE_URL` globally?

That's all-or-nothing — every step goes local and quality craters on the hard
ones. The router gives **per-step** routing with automatic escalation, which is
the only way mixed local/cloud is actually usable. Smithers is the layer that
makes per-step assignment durable and swappable instead of a global coin-flip.
