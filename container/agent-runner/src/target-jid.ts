/**
 * Resolve a chat JID the model supplied (send_message / edit_message /
 * delete_message `target_jid`, schedule_task `target_group_jid`) before it is
 * written to IPC.
 *
 * Every channel's ownsJid() requires a platform prefix ("tg:", "slack:",
 * "dc:", ...) or, for WhatsApp, an "@g.us" / "@s.whatsapp.net" suffix, so a
 * bare id like "-1001234567890" can never be delivered. It used to be accepted
 * here with an optimistic "queued for delivery" reply and dropped by the
 * orchestrator afterwards — by which point a scheduled task had already told
 * itself it posted. Receipt: on 2026-09-12 a scheduled task on a production
 * deployment lost its group announcement this way, and still advanced its own
 * state as if the announcement had gone out.
 *
 * Resolution is deliberately conservative:
 *  - omitted                  → the current chat (unchanged behaviour)
 *  - the current chat's own id without its prefix → the current chat. This is
 *    unambiguous even for ids that themselves contain colons (Teams "19:…",
 *    web "site:session", Signal "group:…"), so it is checked first.
 *  - "telegram:…", or a known prefix in the wrong case
 *                             → canonical prefix; the id itself is untouched
 *  - any other prefix         → passed through; the orchestrator still judges
 *                               deliverability, and plugin channels may own
 *                               prefixes this file doesn't know about
 *  - any other bare id        → rejected, so the model can fix it within the
 *                               same run. The error lists full-JID shapes
 *                               instead of guessing a platform, because the
 *                               target is often on a different channel from
 *                               the chat the agent is running in.
 */

const CANONICAL_PREFIX: Record<string, string> = {
  tg: 'tg',
  telegram: 'tg',
  slack: 'slack',
  dc: 'dc',
  signal: 'signal',
  teams: 'teams',
  web: 'web',
};

export type TargetJidResolution =
  | { ok: true; jid: string }
  | { ok: false; error: string };

function isWhatsAppJid(jid: string): boolean {
  return jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net');
}

export function resolveTargetJid(
  target: string | undefined,
  currentChatJid: string,
  param = 'target_jid',
): TargetJidResolution {
  const raw = target?.trim();
  if (!raw) return { ok: true, jid: currentChatJid };
  if (raw === currentChatJid || isWhatsAppJid(raw)) {
    return { ok: true, jid: raw };
  }

  // Before the prefix split: an id that itself contains a colon would
  // otherwise be mistaken for a prefixed jid and passed straight through.
  const curSep = currentChatJid.indexOf(':');
  if (curSep > 0 && raw === currentChatJid.slice(curSep + 1)) {
    return { ok: true, jid: currentChatJid };
  }

  const sep = raw.indexOf(':');
  if (sep > 0) {
    const canonical = CANONICAL_PREFIX[raw.slice(0, sep).toLowerCase()];
    return {
      ok: true,
      jid: canonical ? `${canonical}:${raw.slice(sep + 1)}` : raw,
    };
  }

  return {
    ok: false,
    error:
      `${param} "${raw}" has no platform prefix, so no channel can deliver to it — nothing was sent. ` +
      `Use the full JID including its prefix, e.g. "tg:-1001234567890" (Telegram group), ` +
      `"tg:1234567890" (Telegram DM) or "slack:C0123456789". ` +
      `To reach the current chat, omit ${param}.`,
  };
}
