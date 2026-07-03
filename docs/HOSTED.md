# Hosted mode (control-plane sync)

labor.fun runs **self-hosted by default**. For the hosted SaaS, each tenant
instance talks to a central **control plane** that (a) hands the instance its
**entitlement** (plan state + monthly budgets) and (b) collects **usage** rows
for metering/billing. Both are strictly opt-in: with neither env var set, the
instance is self-hosted and everything below is dormant.

## Environment

| Var | Meaning |
|-----|---------|
| `CONTROL_PLANE_URL` | Control-plane base URL, e.g. `https://cloud.labor.fun`. |
| `CONTROL_PLANE_TOKEN` | Bearer token identifying this org to the control plane. |

Both are optional. **Absent → self-hosted mode**: no entitlement fetch, no
usage push, budgets come only from the env vars below.

### Local budget env (used when there is no entitlement file)

| Var | Meaning |
|-----|---------|
| `USAGE_MONTHLY_TOKEN_BUDGET` | Month-to-date token cap. Unset = unlimited. |
| `USAGE_MONTHLY_COST_BUDGET_USD` | Month-to-date estimated-cost cap (USD). Unset = unlimited. |

Budget precedence (`src/usage-budget.ts`): **entitlement file → env vars →
unlimited**. A `null` budget in the entitlement means that dimension is
unlimited (it does **not** fall through to env). If the entitlement `state` is
`suspended` or `canceled`, API requests are blocked regardless of budgets; every
other state (`trialing`/`active`/`grace`/`over_quota`) enforces budgets normally.

### Tuning (optional)

| Var | Default | Meaning |
|-----|---------|---------|
| `CONTROL_PLANE_SYNC_INTERVAL_MS` | `300000` | Sync tick interval (5 min). |
| `CONTROL_PLANE_SYNC_FIRST_DELAY_MS` | `15000` | Delay before the first tick after startup. |

## HTTP contract

The instance is a **client**; the control plane implements these two endpoints.
Both require `Authorization: Bearer <CONTROL_PLANE_TOKEN>`.

**`GET {CONTROL_PLANE_URL}/api/instance/entitlement`** → `200` JSON:

```json
{
  "state": "trialing|active|grace|over_quota|suspended|canceled",
  "plan": "free|starter|team|dedicated",
  "monthlyTokenBudget": 250000,
  "monthlyCostBudgetUsd": 20,
  "periodStart": "2026-07-01T00:00:00.000Z",
  "periodEnd": "2026-08-01T00:00:00.000Z"
}
```

`monthlyTokenBudget` / `monthlyCostBudgetUsd` may be `null` (that dimension
unlimited).

**`POST {CONTROL_PLANE_URL}/api/instance/usage`** — body:

```json
{
  "cursor": 41,
  "events": [
    {
      "id": 42, "runTag": null, "model": "claude-opus-4-8",
      "inputTokens": 1200, "outputTokens": 300,
      "cacheReadTokens": 0, "cacheWriteTokens": 0,
      "estCostUsd": 0.0135, "statusCode": 200,
      "createdAt": "2026-07-03T18:04:11.000Z"
    }
  ]
}
```

→ `200` `{"ok": true, "cursor": 42}`. `cursor` is the last `api_usage.id`
already reported; the instance sends rows with `id > cursor`, ≤ 500 per POST,
and loops until drained, advancing its persisted cursor from each response.

## Local entitlement cache: `<profile data dir>/entitlement.json`

Each sync tick atomically (tmp + rename) writes the entitlement to
`entitlement.json` under the profile's data dir (`DATA_DIR`, gitignored). Shape:

```json
{
  "state": "active",
  "plan": "starter",
  "monthlyTokenBudget": 250000,
  "monthlyCostBudgetUsd": 20,
  "periodStart": "2026-07-01T00:00:00.000Z",
  "periodEnd": "2026-08-01T00:00:00.000Z",
  "fetchedAt": "2026-07-03T18:00:00.000Z"
}
```

`src/usage-budget.ts` reads this file (mtime-cached) on each API request. It is
**fail-open**: a missing or corrupt file falls back to env budgets and never
blocks or crashes. A control-plane outage leaves the last-known entitlement in
place until the next successful fetch.

## How it fits together

- `src/credential-proxy.ts` — meters each Messages API call into the `api_usage`
  table and gates requests on `checkQuota()` (returns HTTP 429 when blocked).
- `src/usage-budget.ts` — resolves budgets + state and answers `checkQuota()`.
- `src/integrations/control-plane-sync.ts` — the 5-minute loop: fetch
  entitlement → write cache → drain usage deltas. Self-registered via
  `src/integrations/registry.ts`; dormant unless both env vars are set.
- Table + cursor: see `schema/tables.md` → `api_usage` and the
  `control_plane_usage_cursor` key in `router_state`.
