# Web chat widget channel

A browser-embeddable chat widget — like Intercom/Crisp, but fully self-owned
(no third-party chat API, no external SaaS). It is the default customer-facing
deployment surface for the hosted labor.fun product: a visitor talks to your
assistant directly on your own website.

Like every other channel (Telegram, Slack, Discord, Signal), it self-registers
at startup and is **completely inert unless explicitly enabled**. When enabled
it opens an HTTP server that the browser widget talks to.

- Server: `src/channels/web.ts` (implements the `Channel` interface).
- Client: `public/widget/labor-widget.js` (vanilla JS, no build step, no deps).
- Demo: `public/widget/demo.html`.

## Enabling it

The channel is off by default. It requires three env vars to be present, and
**fails closed** (the factory returns `null`, so the channel is skipped) if it
is enabled but misconfigured — we never half-start an open, unauthenticated
widget.

| Env var                            | Default        | Meaning                                                                                                                                                       |
| ----------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WEB_WIDGET_ENABLED`                | _(off)_        | Must be exactly `true` to start the channel.                                                                                                                 |
| `WEB_WIDGET_SITE_KEY`               | _(required)_   | Public key the widget must present (header `X-Site-Key`). Enabled-but-unset ⇒ channel skipped.                                                               |
| `WEB_WIDGET_ALLOWED_ORIGINS`        | _(required)_   | Comma-separated exact-match CORS origin allowlist, e.g. `https://example.com,https://foo.com`. Empty ⇒ channel skipped.                                      |
| `WEB_WIDGET_PORT`                   | `3100`         | Port the HTTP server listens on. (Avoids the credential-proxy `3001` and smithers-bridge `3002` defaults.)                                                   |
| `WEB_WIDGET_HOST`                   | `0.0.0.0`      | Bind address. Browsers connect directly, so it binds all interfaces by default (see the reverse-proxy note below).                                           |
| `WEB_WIDGET_SITE_ID`                | `default`      | **Non-secret** label used in the jid (see "why the site key is never in the jid").                                                                           |
| `WEB_WIDGET_DEFAULT_GROUP`          | `web-visitors` | Shared group folder all web sessions map into.                                                                                                               |
| `WEB_WIDGET_RATE_LIMIT_PER_MIN`     | `20`           | Messages allowed per **session** per rolling 60s window.                                                                                                     |
| `WEB_WIDGET_MAX_MESSAGE_LENGTH`     | `4000`         | Max characters per message; longer messages are **rejected**, never truncated.                                                                               |
| `WEB_WIDGET_IP_RATE_LIMIT_PER_MIN`  | `60`           | Messages allowed per **client IP** per rolling 60s window, across every sessionId seen from that IP. This is what actually stops a forged-session flood.    |
| `WEB_WIDGET_TRUST_PROXY`            | _(off)_        | Set to `true` only when a trusted reverse proxy sits in front and sets `X-Forwarded-For` itself. Otherwise the header is ignored and the raw socket address used. |

## Embed snippet

One script tag on any page:

```html
<script
  src="https://your-host.example.com/widget/labor-widget.js"
  data-site-key="YOUR_SITE_KEY"
  data-endpoint="https://your-host.example.com:3100"
></script>
```

The script reads its own `data-site-key` and `data-endpoint` attributes,
renders a floating chat bubble, and talks to the widget server. See
`public/widget/demo.html` for a working example.

## HTTP surface

- `OPTIONS *` — CORS preflight. Reflects `Access-Control-Allow-Origin` **only**
  on an exact origin-allowlist match (exact string equality, never
  substring/regex), otherwise responds `403` with no CORS headers.
- `POST /api/message` — the visitor sends `{ sessionId?, text }`. Returns
  `{ sessionId, messageId }`. On the first message the client omits `sessionId`
  and the server mints one and returns it.
- `GET /api/stream?sessionId=…&siteKey=…` — a Server-Sent-Events stream that
  pushes assistant replies (`{ type: "message", text, timestamp }`) back to the
  visitor's open tab(s). The site key rides in a query param here because the
  browser `EventSource` API cannot set request headers.
- `GET /health` — `{ status: "ok" }`.

## How visitor sessions map to jid → group

Each visitor gets an opaque session id (server-minted, validated against
`/^[a-zA-Z0-9_-]{8,128}$/`). The jid is:

```
web:<siteId>:<sessionId>
```

The **first** message from a new session jid auto-registers a group:

```jsonc
{
  "name": "Web visitor <shortSessionId>",
  "folder": "<WEB_WIDGET_DEFAULT_GROUP>", // e.g. "web-visitors"
  "trigger": "@<ASSISTANT_NAME>",
  "requiresTrigger": false, // no @-mention needed; it's a 1:1 chat
}
```

Every session jid gets its **own** `registeredGroups` entry (keyed by jid), but
they **all point at the same `folder`**. Sessions are ephemeral and numerous, so
one shared folder avoids spamming the groups directory with thousands of
throwaway folders. `requiresTrigger: false` means visitor messages don't need an
`@Assistant` prefix — talking to the widget is inherently a 1:1 conversation.

> **⚠️ Shared workspace caveat.** Because every visitor's group folder is the
> same `WEB_WIDGET_DEFAULT_GROUP`, all web-widget conversations currently share
> one filesystem workspace (`CLAUDE.md`, any files an agent writes, any
> accumulated context). This is a deliberate v1 tradeoff — it's what keeps
> `GROUPS_DIR` from growing one throwaway folder per anonymous visitor — but it
> means an agent running for one visitor could, in principle, read or write
> files left behind by a different visitor's turn. If/when web-visitor agents
> are given filesystem-writing tools (vs. read-only/tool-only skills), give
> them a **restricted tool scope or a scratch/tmp working directory** rather
> than the shared group folder's full read/write surface, or move to
> per-session folders with their own retention/cleanup story. Don't just widen
> tool access on this folder without addressing that first.

**Bounded registration (Fix 1).** A visitor session jid is untrusted — a
client can send any `sessionId` matching the opaque-token shape, or omit it
entirely and get a fresh one minted every request. Before this was addressed,
every novel jid grew `registeredGroups` (in-memory) and inserted a permanent
`registered_groups` SQLite row, **neither capped**, and (because
`requiresTrigger: false`) triggered a full container agent spawn on delivery —
so an anonymous visitor with nothing but the public site key and an allowed
Origin could mint unbounded sessions and exhaust memory/DB/compute. The fix
keeps per-session registration (required for correct SSE routing and
per-visitor rate limiting) but bounds the *count* of simultaneously-registered
sessions to `RATE_LIMIT_SESSIONS_MAX` (10,000): once exceeded, the single
oldest session is evicted via `deregisterGroup()`, which removes **both** the
in-memory entry and the persisted SQLite row (the shared folder/data itself is
untouched — same "symmetric removal, data preserved" contract Discord's
DM-role-revocation path already relies on). An evicted session simply
re-registers on its next message, so eviction only bounds how many
registrations can be *live* at once — it never wedges a real, still-active
visitor.

## Security model

- **Origin allowlist.** Every request (POST and the SSE GET) must carry an
  `Origin` header that **exactly** matches an entry in
  `WEB_WIDGET_ALLOWED_ORIGINS`. Missing or non-allowlisted origin ⇒ `403`. We
  require Origin to be present because the widget is meant to be embedded on the
  customer's own site, not called anonymously server-to-server.
- **Site key.** `X-Site-Key` (or the `siteKey` query param on the SSE stream)
  must equal `WEB_WIDGET_SITE_KEY`, else `401`. The comparison uses
  `crypto.timingSafeEqual` (length-guarded so a length mismatch can never
  throw), rather than `!==`. The site key is a public widget credential
  (shipped in the customer's page source), so a timing side-channel has no
  real payoff today — the constant-time comparison is kept anyway as a
  defensive default, in case that assumption ever changes. The key value is
  **never** written to any log.
- **Per-session rate limit.** Fixed 60s window per session, default 20
  messages/min. Over the limit ⇒ `429`. (Fixed window is simpler than a
  sliding window; the tradeoff is up to ~2x the nominal rate can slip through
  at a window boundary, which is fine for widget abuse control.) The counter
  map is LRU-capped so it can't grow unboundedly across many visitors.
- **Per-IP rate limit (`WEB_WIDGET_IP_RATE_LIMIT_PER_MIN`, default 60/min).**
  A visitor picks their own `sessionId`, so the per-session limiter above never
  engages against an attacker who mints a fresh `sessionId` on every request.
  The per-IP limiter closes that gap: it's keyed by the client's IP (raw
  socket address by default; see `WEB_WIDGET_TRUST_PROXY`) and checked right
  after the origin allowlist but **before** the site-key check, body parsing,
  session registration, or message delivery — so a flood is rejected with
  `429` as early as possible, never reaching `registerSessionGroup()` or
  `onMessage()`. Same fixed-window mechanics and LRU cap as the per-session
  limiter.
- **`X-Forwarded-For` is untrusted by default.** Blindly trusting
  `X-Forwarded-For` would let any client self-report an arbitrary "source IP"
  and bypass the per-IP limiter entirely. It is only honored when
  `WEB_WIDGET_TRUST_PROXY=true`, and even then only the **first** entry (the
  original client, per the standard append convention) is used, never the
  last (which would be the nearest hop / the proxy itself). Without a trusted
  proxy in front, set (or leave) `WEB_WIDGET_TRUST_PROXY` unset/`false` and the
  raw socket address is used unconditionally.
- **Message length cap.** Over `WEB_WIDGET_MAX_MESSAGE_LENGTH` ⇒ `400` (rejected,
  not truncated). The raw request body is size-capped at 32KB before JSON parse.
- **Session-id validation.** A client-supplied `sessionId` is untrusted and must
  match the opaque-token regex above, or it's rejected; otherwise the server
  mints one. It is never used to build a filesystem path — the only `folder`
  ever used is the fixed `WEB_WIDGET_DEFAULT_GROUP` constant.
- **Why the site key is never in the jid.** The task's jid shape is
  `web:<siteId>:<sessionId>`. The `<siteId>` segment is the **non-secret**
  `WEB_WIDGET_SITE_ID` (default `default`), **not** the secret
  `WEB_WIDGET_SITE_KEY`. Putting the secret key in the jid would leak it into
  logs, the SQLite `messages` table, and KB folder names. The site id is a
  public namespacing label; the site key is a credential.
- **XSS.** The server only ever emits JSON / SSE data frames — it never renders
  HTML from visitor input, so server-side XSS is impossible. The browser widget
  renders every message (both the visitor's echoed input and assistant replies)
  with `textContent`, never `innerHTML`, so untrusted text can't inject markup.
- **Log hygiene.** The jid embeds the session id, so both the POST and SSE
  paths log "message received" / "stream opened" at `debug`, never `info` —
  keeping session identifiers out of default-level, potentially
  third-party-visible logs.

### v1 limitations

- **No offline queue.** If a visitor has no open SSE stream when a reply is
  produced (closed tab, etc.), the reply is dropped — matching the other
  channels' best-effort, fire-and-forget send semantics.

## Plaintext HTTP — put a reverse proxy in front

This channel does **plaintext HTTP only**; like the other channels it does no
TLS of its own. In production, run a TLS-terminating reverse proxy (nginx,
Caddy, a cloud load balancer, …) in front of `WEB_WIDGET_PORT` and point the
widget's `data-endpoint` at the HTTPS origin. The SSE endpoint holds
connections open; configure your proxy's read timeout accordingly (the server
sends a `: ping` heartbeat every ~25s to keep idle streams alive).

## Self-host vs hosted SaaS

- **Self-host:** the operator sets the env vars above and points DNS + a
  TLS-terminating reverse proxy at `WEB_WIDGET_PORT`.
- **Hosted SaaS:** the control plane is expected to provision per-tenant site
  keys / site ids and a shared ingress (the multi-tenant architecture isn't
  finalized in this codebase yet).
