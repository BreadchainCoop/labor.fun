---
name: add-signal
description: Add Signal as a channel. Runs alongside any other channels. Talks to a local signal-cli JSON-RPC daemon — no bot token (Signal has no official bot API). Triggers on "add signal", "signal integration", "signal channel".
---

# Add Signal Channel

This skill adds Signal support to Breadbrich Engels, then walks through interactive setup.

Signal has **no official bot API**. The channel talks to a locally-running
[`signal-cli`](https://github.com/AsamK/signal-cli) daemon over its JSON-RPC
interface (newline-delimited JSON over a TCP socket). The same socket carries
both directions — outbound `send` requests and inbound `receive` notifications
— so no public URL, webhook, or extra npm dependency is needed (Node's built-in
`net` module does the work).

## Phase 1: Pre-flight

### Check if already applied

Check if `src/channels/signal.ts` exists. If it does, the code is in place —
skip to Phase 2 (Setup).

If it does **not** exist, the channel code needs to be merged first. It lives on
the framework's `main` (or a `skill/signal` branch). Pull it in, then validate:

```bash
npm install
npm run build
npx vitest run src/channels/signal.test.ts
```

All tests must pass and the build must be clean before continuing.

## Phase 2: Setup

### Install signal-cli on the host

`signal-cli` is a separate binary that owns the Signal account and speaks the
JSON-RPC the channel connects to.

```bash
# macOS
brew install signal-cli

# Debian/Ubuntu (or download a release from github.com/AsamK/signal-cli/releases)
#   signal-cli needs a JRE 21+ on the PATH
```

Verify: `signal-cli --version`

### Register or link a Signal number

`SIGNAL_ACCOUNT` is the Signal phone number (E.164, e.g. `+15551234567`) that
signal-cli controls. Two options — ask the user which they want:

**Option A — link to an existing phone (recommended, fastest):**

```bash
signal-cli link -n "breadbrich"
# Prints a tsdevice:/ URI. Render it as a QR code (e.g. paste into
# `qrencode -t ansiutf8 "<uri>"`) and scan it from the phone:
#   Signal app → Settings → Linked Devices → Link New Device
```

The account number is the phone's own number.

**Option B — register a dedicated number** (needs a number that can receive an
SMS/voice code, e.g. a Google Voice or Twilio number):

```bash
signal-cli -a "+15551234567" register          # add --voice if SMS is blocked
signal-cli -a "+15551234567" verify <CODE>      # code from the SMS/call
```

### Configure environment

Add to `.env`:

```bash
SIGNAL_ACCOUNT=+15551234567
SIGNAL_RPC_TCP=127.0.0.1:7583   # optional; this is the default
```

Channels auto-enable when their credentials are present — no extra config.

Sync to the container environment (the container reads `data/env/env`, not
`.env` directly):

```bash
mkdir -p data/env && cp .env data/env/env
```

### Run the signal-cli daemon

The channel connects to a long-running daemon — it does **not** spawn one. Keep
it running (a launchd/systemd service is best; for a quick test, a terminal is
fine):

```bash
signal-cli -a "$SIGNAL_ACCOUNT" daemon --tcp 127.0.0.1:7583
```

For a managed service on Linux:

```ini
# /etc/systemd/system/signal-cli.service
[Service]
ExecStart=/usr/bin/signal-cli -a +15551234567 daemon --tcp 127.0.0.1:7583
Restart=always
```

> The channel auto-reconnects with backoff if the daemon restarts, so order of
> startup doesn't matter — but messages sent while the daemon is down are
> dropped.

### Build and restart Breadbrich Engels

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.breadbrich   # macOS
# Linux: systemctl --user restart breadbrich
```

On startup the logs should show `Signal JSON-RPC daemon connected`.

## Phase 3: Registration

Signal chats use these JID formats:

| Chat type | JID | How to find it |
|-----------|-----|----------------|
| Direct message | `signal:+15551234567` | the other person's E.164 number |
| Group | `signal:group:<base64GroupId>` | `signal-cli -a "$SIGNAL_ACCOUNT" listGroups` → the `Id` column |

Get the group id when needed:

```bash
signal-cli -a "$SIGNAL_ACCOUNT" listGroups
```

Register the chat (uses `setup/index.ts --step register`):

For a main chat (responds to all messages):

```bash
npx tsx setup/index.ts --step register -- --jid "signal:+15551234567" --name "<name>" --folder "signal_main" --trigger "@${ASSISTANT_NAME}" --channel signal --no-trigger-required --is-main
```

For additional chats (trigger-only):

```bash
npx tsx setup/index.ts --step register -- --jid "signal:group:<id>" --name "<name>" --folder "signal_<group-name>" --trigger "@${ASSISTANT_NAME}" --channel signal
```

## Phase 4: Verify

Tell the user:

> From the registered Signal chat, send a message:
> - Main chat: any message works
> - Non-main: `@Breadbrich Engels hello`
>
> The assistant should react with 👀 and reply within a few seconds.

Check logs if needed:

```bash
tail -f logs/breadbrich.log
```

## What this channel supports

- Inbound DMs and groups (text + attachment placeholders), quote/reply context
- Outbound sends with native Signal rich text (**bold**, _italic_, `code`,
  ~~strike~~, ||spoiler||) via the JSON-RPC `textStyles` parameter
- Typing indicators and emoji reactions (the 👀 / 🤔 ACK pattern)

## Troubleshooting

### `Signal: SIGNAL_ACCOUNT not set` in logs
`SIGNAL_ACCOUNT` is missing from `.env` **and** `data/env/env`. Set it in both
(`cp .env data/env/env`) and restart.

### `Signal socket not connected` / repeated reconnect warnings
The signal-cli daemon isn't running or isn't listening on `SIGNAL_RPC_TCP`.
Confirm with `signal-cli -a "$SIGNAL_ACCOUNT" daemon --tcp 127.0.0.1:7583` and
that the host/port matches `SIGNAL_RPC_TCP`.

### Messages received but no reply
The chat isn't registered, or (for non-main) the message lacks the trigger.
Check: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'signal:%'"`

### Registered the wrong number
DM JIDs must be the E.164 number with `+`. Group JIDs use the base64 `Id` from
`signal-cli listGroups`, prefixed with `signal:group:`.

## Removal

1. Delete `src/channels/signal.ts` and `src/channels/signal.test.ts`
2. Remove `import './signal.js'` from `src/channels/index.ts`
3. Remove `SIGNAL_ACCOUNT` / `SIGNAL_RPC_TCP` from `.env` and `data/env/env`
4. Remove registrations: `sqlite3 store/messages.db "DELETE FROM registered_groups WHERE jid LIKE 'signal:%'"`
5. Stop the signal-cli daemon
6. Rebuild: `npm run build && launchctl kickstart -k gui/$(id -u)/com.breadbrich` (macOS) or `npm run build && systemctl --user restart breadbrich` (Linux)
