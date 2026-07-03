# Hosted Operations (concierge phase)

Operator runbook for running labor.fun as a hosted service, before a
self-serve control plane exists. Right now "hosted" means: we operate one
shared checkout, each customer gets a `profiles/<customer>/` directory, and we
do the provisioning by hand. This doc is that checklist.

For the underlying concepts (what a profile is, what fields mean) see
[NEW-ORG-GUIDE.md](NEW-ORG-GUIDE.md) — this doc only adds the hosted-specific
steps (Slack app creation, budgets, offboarding) on top of it. For deploy
mechanics (rsync, rollback, backups) see [DEPLOY.md](DEPLOY.md) — don't deploy
by hand outside that flow.

## Per-customer onboarding checklist

### 1. Clone the profile

```bash
cp -r profiles/example profiles/<customer>
```

Never edit `profiles/example` in place — it's the template every clone starts
from.

### 2. Fill in `profiles/<customer>/profile.config.json`

Minimum fields to set (see [NEW-ORG-GUIDE.md §3](NEW-ORG-GUIDE.md) for the full
field reference):

| Field | Set to |
|---|---|
| `assistantName` | Customer's chosen name (collected via sales/intake, or left as a sensible default and changed during onboarding — see step 6) |
| `orgName` / `orgShortName` / `orgWebsite` | Customer's org identity |
| `githubOrg` | Only if they want GitHub integration; leave placeholder otherwise |
| `sharedKbGroup` | Leave as the default main-channel folder name (e.g. `slack_main`) unless there's a reason to change it |
| `serviceUser` | Leave as the shared host's service user — hosted customers don't get their own OS user in the concierge phase |
| `timezone` | Customer's primary timezone (can also be confirmed conversationally during onboarding) |
| `enabledSkills` | Add `"onboarding"` (see step 6) |

### 3. `.env` entries for this customer

We run one shared `.env` / vault per host in the concierge phase, so most
values (channel tokens) are per-registration, not per-profile. Set:

- **Credentials**: our own `ANTHROPIC_API_KEY` in the credential vault (OneCLI)
  or `.env` — this is "api-key mode" (pay-per-use), distinct from a customer
  bringing their own Claude subscription via `CLAUDE_CODE_OAUTH_TOKEN`. For
  hosted customers, use our API key so we can budget/meter usage per profile.
- **Channel tokens**: `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` (from the Slack app
  you create in step 4), or `TELEGRAM_BOT_TOKEN` / `DISCORD_BOT_TOKEN` for
  other channels. See `.env.example` for the full list of channel variables.
- **Usage budget**: `USAGE_MONTHLY_COST_BUDGET_USD` — per-profile monthly
  spend cap in USD (being wired up alongside this doc; check `.env.example`
  and `src/` for the current mechanism if it's not there yet). A free-tier
  hosted customer gets **3.00**.
- **Resource limits**: `src/container-runner.ts` does not currently expose
  configurable per-container CPU/memory limits — don't promise resource
  isolation to a customer until that lands.

Sync whatever you add in `.env` to the container-visible copy:

```bash
mkdir -p data/env && cp .env data/env/env
```

### 4. Create the Slack app

Use [`docs/slack-app-manifest.yml`](slack-app-manifest.yml) — paste it into
Slack's "create app from manifest" flow in the customer's workspace, install
it, and collect `SLACK_BOT_TOKEN` (Bot User OAuth Token) and `SLACK_APP_TOKEN`
(App-Level Token with `connections:write`). See the manifest file's own
comments for exact steps. For other channels, use the channel's own skill
(`/add-telegram`, `/add-discord`) instead — there's no manifest-style shortcut
for those yet.

### 5. Register the main group

Once the bot is in the customer's main Slack channel and you have its channel
ID (`C...` from the channel URL), register it as the **main** group:

```bash
LABOR_PROFILE=<customer> npx tsx setup/index.ts --step register -- \
  --jid "slack:<channel-id>" \
  --name "<channel-name>" \
  --folder "slack_main" \
  --trigger "@<AssistantName>" \
  --channel slack \
  --no-trigger-required \
  --is-main \
  --assistant-name "<AssistantName>"
```

Flags, exactly as `setup/register.ts` parses them: `--jid`, `--name`,
`--trigger`, `--folder`, `--channel` all required; `--no-trigger-required`
(main channels respond to everything, no @mention needed) and `--is-main` are
boolean flags with no value; `--assistant-name` is optional and overrides the
profile's configured name (persisted to `.env`). Omitting it falls back to the
profile's `assistantName`.

This creates `profiles/<customer>/groups/slack_main/` with a `CLAUDE.md`
seeded from the `main` template (`{{ASSISTANT_NAME}}` substituted).

### 6. Enable the onboarding skill

Add `"onboarding"` to `enabledSkills` in `profile.config.json` (it ships with
`default: false`, so it's off unless listed). This is what makes the assistant
run its first-run conversational setup in the newly registered group — see
`container/skills/onboarding/SKILL.md`. Nothing else to configure; it detects
the fresh group automatically on first message, or on request ("onboarding").

### 7. Verify

- `npx tsx setup/index.ts --step verify` (or the equivalent check against the
  right `LABOR_PROFILE`) — confirms service, credentials, channel auth, and
  registered groups.
- Send a message in the customer's Slack channel. The assistant should
  introduce itself and start the onboarding conversation (step 6) or respond
  normally if onboarding already ran.
- Confirm the usage budget is attached to the right profile — check whatever
  budget-tracking surface exists once `USAGE_MONTHLY_COST_BUDGET_USD` lands
  (kb-ui dashboard or DB table — TBD, follow up once the parallel work merges).

## Offboarding a customer

1. Stop the customer's registered groups from receiving traffic — either
   remove their registration rows or stop the shared service temporarily if
   you need a hard cutover (rare; most offboarding is just archiving).
2. Archive the profile directory rather than deleting it (in case of billing
   disputes or a reactivation request):
   ```bash
   mv profiles/<customer> profiles/_archived-<customer>-$(date +%Y%m%d)
   ```
3. Remove the customer's channel tokens from `.env` / `data/env/env` and
   revoke the Slack app (Slack app settings → delete app, or at minimum
   uninstall it from the workspace) so we're not holding a live token for a
   canceled account.
4. Note the offboarding date somewhere durable (billing system, spreadsheet —
   whatever tracks hosted customers today); this doc doesn't own that record.

## Notes / open gaps found while writing this

- No per-profile control plane UI exists yet — every step above is manual, on
  the shared host, by an operator with shell access. That's the explicit scope
  of "concierge phase."
- `USAGE_MONTHLY_COST_BUDGET_USD` was not present in the codebase at the time
  of writing (parallel work); verify the env var name and enforcement point
  before relying on it operationally.
- Per-container CPU/memory resource limits are not currently configurable —
  don't promise resource isolation guarantees to customers until they exist.
