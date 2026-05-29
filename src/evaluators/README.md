# Post-turn Evaluators

Evaluators are small, declarative units that run **after** the agent has
responded to a turn, performing deterministic follow-up bookkeeping in the
orchestrator process. The pattern is lifted from
[elizaOS](https://github.com/elizaos/eliza)'s evaluator concept.

They exist so behaviour the rules currently ask the *agent* to remember (e.g.
"log every interaction") can instead be **enforced by code**, regardless of
what the model did inside the container. Evaluators run on the host, so they
have direct filesystem + DB access and spend **zero API credits**.

## Lifecycle

`runEvaluators(ctx)` is called from `src/index.ts` after a successful turn,
once the reply has already been sent to the user. For each evaluator, sorted
by `priority` (lower first; `name` breaks ties):

1. `validate(ctx)` — cheap gate; return `false` to skip.
2. `handler(ctx)` — side-effecting work.

Handlers run **sequentially** and errors are **isolated** — a throwing
evaluator is logged and the rest still run. The pipeline never affects the
message cursor or the reply.

## Built-in evaluators

| Name | Priority | Does |
|------|----------|------|
| `request-log` | 10 | Appends a row to `context/artifacts/request_log.md` (enforces `rules/knowledge-base/request-logging.md`). |
| `kb-reindex` | 90 | Incrementally re-indexes the group's KB for full-text search (`src/kb-index.ts`). |

## Adding an evaluator

1. Create `src/evaluators/<name>.ts` exporting an `Evaluator`:

   ```ts
   import { Evaluator, EvaluatorContext } from './types.js';

   export const myEvaluator: Evaluator = {
     name: 'my-evaluator',
     priority: 50,
     validate: (ctx) => ctx.userMessages.length > 0,
     handler: async (ctx) => {
       // ...follow-up work using ctx.responseText, ctx.contextDir, etc.
     },
   };
   ```

2. Register it in `DEFAULT_EVALUATORS` in `index.ts`.
3. Add a test in `index.test.ts`.

### Ideas for future evaluators

- **action-item-extract** — scan `responseText` + `userMessages` for
  commitments ("by Friday", "can you", "I'll") and append candidates to a
  review inbox (append-only; don't auto-create canonical tasks).
- **summary** — maintain a rolling per-group conversation summary.
- **privacy-scrub** — assert the reply didn't leak `visibility: private` KB
  content, flagging for review if it did.

These can be LLM-backed (call the credential proxy) — but prefer deterministic
logic where it suffices, to conserve API credits.
