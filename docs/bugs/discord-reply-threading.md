# Bug: Discord replies thread off the wrong message

## Status

Fixed in `fix/discord-reply-threading` (PR #—).

## Symptom

When a user @-mentions the bot and then sends a *second* message before the
bot finishes processing, the bot's reply is threaded off the **second**
(newer) message instead of the one that triggered the response.

Example sequence:

```
[2:54 PM] Josh: @Breadbrich Engels can you summarize this video? <url>
[2:57 PM] Josh: id say go for it, no need to ask about it   ← reply to someone else
[3:05 PM] Bot:  Here is the summary...   ← WRONG: threaded off the 2:57 message
```

The bot's summary appears to be a reply to "id say go for it" rather than
to the video-summary request.

## Root Cause

`DiscordChannel` maintains a `lastReplyAnchor: Map<chatJid, Message>` that
records the most recent inbound message per channel. `resolveReplyTarget()`
reads it lazily at **send-time**, not at the time the message was received.

Race condition:

1. Message A arrives → agent is triggered → `lastReplyAnchor[jid] = A`
2. Message B arrives → `lastReplyAnchor[jid] = B`  (overwrites!)
3. Agent finishes processing A, calls `sendMessage(jid, text)`
4. `resolveReplyTarget(jid)` reads `lastReplyAnchor` → gets B
5. Bot starts a thread on B instead of A ❌

## Fix

A **session anchor** is now pinned to the triggering message at the start
of each agent run and cleared when the run ends:

### New fields in `DiscordChannel`

- `messageAnchors: Map<messageId, Message>` — LRU cache (max 500) of every
  inbound message, so the anchor can be looked up by ID.
- `pinnedReplyAnchor: Map<chatJid, Message>` — the pinned anchor for the
  current session; takes priority over `lastReplyAnchor` in
  `resolveReplyTarget`.

### New methods on `Channel` interface (optional)

- `setSessionAnchor(jid, messageId)` — looks up `messageId` in
  `messageAnchors` and pins it as the reply target for this session.
- `clearSessionAnchor(jid)` — removes the pin so subsequent scheduled /
  proactive messages fall back to `lastReplyAnchor` (or the raw channel).

### `processGroupMessages` in `index.ts`

```typescript
// Before agent run:
if (triggerMessageId) {
  channel.setSessionAnchor?.(chatJid, triggerMessageId);
}

// After agent run (in the finally-equivalent cleanup block):
channel.clearSessionAnchor?.(chatJid);
```

## Why `lastReplyAnchor` is still needed

`lastReplyAnchor` is kept for two reasons:

1. **Fallback** — if the bot restarts between receiving the trigger message
   and starting the agent run, `messageAnchors` is empty and
   `setSessionAnchor` silently no-ops. The reply falls back to
   `lastReplyAnchor` (the same behaviour as before the fix).
2. **Scheduled / proactive messages** — tasks that fire without an inbound
   trigger never call `setSessionAnchor`, so they still use `lastReplyAnchor`
   (which is cleared after each send to avoid reviving stale threads).
