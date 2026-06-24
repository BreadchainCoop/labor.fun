/**
 * Deliverability classification for outbound IPC `message` sends.
 *
 * Background — the silent-escalation bug (see issue #95):
 * The agent's `send_message` tool is fire-and-forget. The container-side tool
 * returns immediately the instant it writes the IPC file, and the orchestrator
 * watcher used to only *log* on failure. So a send to a JID that no connected
 * channel can route — the classic case being an escalation to `slack:…` on a
 * deployment that has no Slack channel configured — was logged-and-dropped
 * while the user/agent had already been told the message was sent. The
 * escalation vanished with zero signal.
 *
 * This module is the pure, dependency-free decision at the heart of the fix:
 * given whether a connected channel can route the JID (and whether it's a
 * known registered chat), decide if the send is deliverable and, when not,
 * produce a clear reason the watcher can surface back to the *source* chat
 * (mirroring how `dm_user` already reports failures). Keeping it free of fs /
 * db / channel imports makes it trivially unit-testable.
 */

export interface DeliverabilityInput {
  /**
   * True when a connected channel claims this JID, i.e. routing the send
   * won't immediately fail with "No channel for JID". This mirrors the
   * orchestrator's actual send path (`findChannel`).
   */
  hasChannel: boolean;
  /** True when the JID is a known, registered group/chat. */
  isRegistered: boolean;
}

export type DeliverabilityVerdict =
  | { deliverable: true }
  | { deliverable: false; reason: string };

/**
 * Map a JID to a human-readable platform name from its prefix/suffix, or
 * `null` when unrecognized. Used only to make error text actionable.
 */
export function jidPlatform(jid: string): string | null {
  const prefix = jid.split(':', 1)[0];
  switch (prefix) {
    case 'tg':
      return 'Telegram';
    case 'slack':
      return 'Slack';
    case 'dc':
      return 'Discord';
    default:
      break;
  }
  if (jid.endsWith('@g.us') || jid.endsWith('@s.whatsapp.net')) {
    return 'WhatsApp';
  }
  return null;
}

/**
 * Decide whether an outbound message to `jid` is deliverable. When it isn't,
 * the returned `reason` is a complete, user-facing clause (no leading capital,
 * no trailing period) intended to be embedded in a notice posted back to the
 * source chat, e.g. `Your message ${reason}.`
 */
export function classifyDeliverability(
  jid: string,
  input: DeliverabilityInput,
): DeliverabilityVerdict {
  if (input.hasChannel) {
    return { deliverable: true };
  }

  const platform = jidPlatform(jid);
  const dest = platform ? `${platform} messages` : 'that destination';
  const base = `couldn't be delivered to \`${jid}\` — no connected channel handles ${dest} on this deployment`;
  const hint = input.isRegistered
    ? ' (the chat is registered, but its channel is not connected right now)'
    : ' (is that platform configured here, and is the JID correct?)';

  return { deliverable: false, reason: base + hint };
}
