---
name: add-teams
description: Set up Microsoft Teams as a channel. The Teams channel code already ships in the framework (src/channels/teams.ts) — this skill walks through the Azure Bot registration and configuration to turn it on. Teams is the #1 chat platform in Microsoft-shop / enterprise orgs.
---

# Add Microsoft Teams Channel

The Teams channel is built in (`src/channels/teams.ts`, via the Bot Framework).
Unlike branch-merged channels there is **no code to merge** — it stays inert
until `TEAMS_ENABLED=true` and the Azure Bot credentials are set. This skill
walks the operator through the Azure setup and configuration.

## Phase 1: Pre-flight

### Check state
- Confirm `src/channels/teams.ts` exists (it should — it's in main). If not, the
  install predates the Teams channel; run `/update-nanoclaw` first.
- Teams delivery is **HTTP push** from the Bot Framework, so the messaging
  endpoint must be reachable at a **public HTTPS URL** (a domain + TLS, or a
  tunnel for testing). Unlike Slack Socket Mode, there is no no-public-URL mode.

### Ask the user
- The public HTTPS base URL that will front the bot (e.g. `https://bot.acme.com`).
- Whether they can create an Azure Bot resource (needs an Azure subscription +
  permission to register an Entra ID / Azure AD app).

## Phase 2: Azure Bot registration

Guide the user through the Azure portal (portal.azure.com):

1. **Create an Azure Bot** resource ("Azure Bot" in the Marketplace).
   - App type: **Multi-tenant** (simplest) or Single-tenant (then capture the
     tenant id). Let Azure **create a new Microsoft App ID**.
2. From the bot's **Configuration** blade, copy the **Microsoft App ID** →
   `TEAMS_APP_ID`. If single-tenant, copy the **App Tenant ID** →
   `TEAMS_APP_TENANT_ID` (leave empty for multi-tenant).
3. **Manage** the app → **Certificates & secrets** → **New client secret** →
   copy the secret **Value** (not the id) → `TEAMS_APP_PASSWORD`. It is shown
   once; store it in the vault / `.env` immediately.
4. Set the bot's **Messaging endpoint** to
   `https://<your-public-host>/api/messages`. The channel accepts the Bot
   Framework activity on any path (POST), and answers `GET` as a health probe;
   `/api/messages` is just the Bot Framework convention. The port is internal —
   front it with your reverse proxy / TLS terminator.
5. Under **Channels**, add the **Microsoft Teams** channel.

## Phase 3: Configure environment

Add to the vault / `.env` (never commit secrets):

```
TEAMS_ENABLED=true
TEAMS_APP_ID=<Microsoft App ID>
TEAMS_APP_PASSWORD=<client secret Value>
TEAMS_APP_TENANT_ID=<tenant id, or empty for multi-tenant>
TEAMS_MESSAGING_PORT=3200        # internal port the channel listens on; proxy 443 → this
TEAMS_HOST=0.0.0.0               # bind address (default is fine behind a proxy)
```

The reverse proxy in front terminates TLS for the public host and forwards
`/api/messages` to `TEAMS_MESSAGING_PORT`. Inbound activities are authenticated
by the channel against the Bot Framework using the app credentials — an
unauthenticated POST is rejected.

## Phase 4: Add the bot to Teams

1. In the Teams admin center or via a Teams **app manifest** (Developer Portal
   at dev.teams.microsoft.com), create a Teams app that references
   `TEAMS_APP_ID` as the bot, with the `bot` scope for **team** and **personal**
   (1:1) chats. Enable the messaging capability.
2. Sideload / publish the app and **add the bot to a team or start a 1:1 chat**.

## Phase 5: Build, restart, register

```bash
npm run build
# restart the service (systemctl restart <service>, or /redeploy-breadbrich)
```

- In a Teams **channel**, the bot only sees messages where it is **@mentioned**;
  in a **1:1 chat** it sees every message. The channel strips its own @mention
  from the text before routing.
- Register the Teams conversation as a group so the assistant will respond. The
  JID scheme is `teams:<conversationId>`. Send one message that @mentions the
  bot; find the resulting `teams:` JID in the logs, then register it:

```bash
npx tsx setup/index.ts --step register -- \
  --jid "teams:<conversationId>" --name "Acme Eng" \
  --trigger "@YourAssistant" --folder "teams_eng" --channel teams
```

(Use `--is-main --no-trigger-required` only for the single privileged control
conversation.)

## Phase 6: Verify

- `@mention` the bot in the registered channel (or DM it) and confirm a reply.
- If nothing happens, check logs for `Teams channel connected` / auth errors,
  confirm the Azure **Messaging endpoint** exactly matches your public
  `/api/messages` URL, and that the reverse proxy forwards to
  `TEAMS_MESSAGING_PORT`.

## Troubleshooting

- **No reply, no logs of inbound activity** — the Bot Framework can't reach your
  endpoint. Verify the public HTTPS URL resolves, TLS is valid, and the proxy
  forwards `/api/messages` to the internal port. Test the Azure "Test in Web
  Chat" from the bot's Overview.
- **401 from the channel on inbound** — `TEAMS_APP_ID`/`TEAMS_APP_PASSWORD`
  mismatch, or a single-tenant app missing `TEAMS_APP_TENANT_ID`.
- **Bot in a channel never triggers** — it only responds to @mentions in
  channels; confirm the message actually @mentions the bot, and that the
  conversation is registered with a matching trigger (or `--no-trigger-required`).
