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
2. **Anthropic API** (small fast model) when an `ANTHROPIC_API_KEY` is
   available to the orchestrator.
3. Neither → commands reply "Translation is not configured for this
   deployment."

## State

Per-chat preferences live in the `chat_translate_prefs` table
(`store/messages.db`): the group pair (`lang1`/`lang2`/`enabled`) and a JSON
map of per-user opt-ins (`user_langs`). See `src/translate-commands.ts` and
`src/translate-service.ts`.
