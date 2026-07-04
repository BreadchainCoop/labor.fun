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

| Env var                         | Default        | Meaning                                                                                                                 |
| ------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `WEB_WIDGET_ENABLED`            | _(off)_        | Must be exactly `true` to start the channel.                                                                            |
| `WEB_WIDGET_SITE_KEY`           | _(required)_   | Public key the widget must present (header `X-Site-Key`). Enabled-but-unset ⇒ channel skipped.                          |
| `WEB_WIDGET_ALLOWED_ORIGINS`    | _(required)_   | Comma-separated exact-match CORS origin allowlist, e.g. `https://example.com,https://foo.com`. Empty ⇒ channel skipped. |
| `WEB_WIDGET_PORT`               | `3100`         | Port the HTTP server listens on. (Avoids the credential-proxy `3001` and smithers-bridge `3002` defaults.)              |
| `WEB_WIDGET_HOST`               | `0.0.0.0`      | Bind address. Browsers connect directly, so it binds all interfaces by default (see the reverse-proxy note below).      |
| `WEB_WIDGET_SITE_ID`            | `default`      | **Non-secret** label used in the jid (see "why the site key is never in the jid").                                      |
| `WEB_WIDGET_DEFAULT_GROUP`      | `web-visitors` | Shared group folder all web sessions map into.                                                                          |
| `WEB_WIDGET_RATE_LIMIT_PER_MIN` | `20`           | Messages allowed per session per rolling 60s window.                                                                    |
| `WEB_WIDGET_MAX_MESSAGE_LENGTH` | `4000`         | Max characters per message; longer messages are **rejected**, never truncated.                                          |

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

## Security model

- **Origin allowlist.** Every request (POST and the SSE GET) must carry an
  `Origin` header that **exactly** matches an entry in
  `WEB_WIDGET_ALLOWED_ORIGINS`. Missing or non-allowlisted origin ⇒ `403`. We
  require Origin to be present because the widget is meant to be embedded on the
  customer's own site, not called anonymously server-to-server.
- **Site key.** `X-Site-Key` (or the `siteKey` query param on the SSE stream)
  must exactly equal `WEB_WIDGET_SITE_KEY`, else `401`. The site key value is
  **never** written to any log.
- **Rate limit.** Fixed 60s window per session, default 20 messages/min. Over
  the limit ⇒ `429`. (Fixed window is simpler than a sliding window; the
  tradeoff is up to ~2x the nominal rate can slip through at a window boundary,
  which is fine for widget abuse control.) The counter map is LRU-capped so it
  can't grow unboundedly across many visitors.
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
