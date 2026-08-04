# Translation

Chat translation is a **pre-agent** feature: the commands and the
auto-translate middleware run inside the orchestrator process, before a
message is stored and independent of the trigger pattern. No agent container
is ever spawned; replies go out directly through the owning channel. It works
identically on every channel (Signal, Telegram, WhatsApp, Slack, Discord) in
any registered group.

## Command Surface

| Command | Effect |
|---------|--------|
| `!translate <lang>` | One-shot: translate the quoted/replied-to message into `<lang>`. Without a quote, translates the most recent non-command message in the chat. |
| `!translate-on <l1> <l2>` | Group bidirectional auto-translate: every text message detected as `l1` is translated to `l2` and vice versa. Alias: `!translation-on`. Group chats only. |
| `!translate-off` | Disable group auto-translate. Alias: `!translation-off`. |
| `!translate-me on <lang>` | Per-user opt-in: *your* messages are auto-translated into `<lang>` (convenience form: `!translate-me <lang>`). Alias: `!translation-me`. Group chats only. |
| `!translate-me off` | Disable your per-user opt-in. |
| `!list-langs` | List the 30 supported languages (code, name, flag). |

Languages are accepted as ISO 639-1 codes (`es`) or common names
(`Spanish`, `español`).

## Behavior Notes

- Auto-translate replies are the translation only, prefixed with the target
  language's flag emoji (e.g. `🇺🇸 Hello everyone`). The original stays
  visible in the thread.
- Language detection uses a statistical detector plus short-message
  heuristics (casual English/Spanish markers); Portuguese/Catalan/Galician
  detections are treated as Spanish when Spanish is one side of the active
  pair.
- Loop guards: the bot's own messages, `!`/`/` commands, media placeholders,
  and messages that are themselves translation replies are never translated.
- Rate limit: at most `TRANSLATE_RATE_LIMIT_PER_MIN` (default 30)
  auto-translations per chat per rolling minute; over-limit messages are
  silently skipped.
- Handled commands are still stored in message history but never trigger the
  agent.

## Provider

Selected automatically at call time (20s timeout, failures never crash the
message loop):

1. **OpenAI-compatible endpoint** when the local/NEAR AI backend is active
   (`NANOCLAW_BACKEND=local`, or implied by `NEAR_AI_API_KEY`) — uses
   `LOCAL_LLM_BASE_URL` / `LOCAL_LLM_API_KEY` / `LOCAL_LLM_MODEL`.
2. **Anthropic API** (small fast model) when *any* Anthropic credential is
   available to the orchestrator — `ANTHROPIC_API_KEY` **or** a Claude Code
   OAuth token (`CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_AUTH_TOKEN`). Hosted
   tenants are OAuth-only, so both must work. The credential is resolved by
   `src/anthropic-auth.ts`, shared with the credential proxy.

   `/v1/messages` is **always** authenticated with `x-api-key`. An OAuth token
   is not accepted there: it is first exchanged for a temporary API key via
   `POST /api/oauth/claude_cli/create_api_key` (`Authorization: Bearer <token>`
   \+ the `oauth-2025-04-20` beta → `{ "raw_key": … }`) — the same exchange the
   credential proxy relays for container traffic. The exchanged key is cached
   (~10 min, re-exchanged on a 401), so a busy group does one exchange, not one
   per message.
3. Neither → commands reply "Translation is not configured for this
   deployment."

If the OAuth exchange itself fails (bad/expired token, network), translation
reports **not configured** for a cooldown window rather than failing per
message: auto-translate stays silent and explicit commands give the honest
"not configured" reply.

## State

Per-chat preferences live in the `chat_translate_prefs` table
(`store/messages.db`): the group pair (`lang1`/`lang2`/`enabled`) and a JSON
map of per-user opt-ins (`user_langs`). See `src/translate-commands.ts` and
`src/translate-service.ts`.
