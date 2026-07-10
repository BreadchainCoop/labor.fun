import {
  Channel,
  OnInboundMessage,
  OnChatMetadata,
  RegisteredGroup,
} from '../types.js';

export interface ChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  // Channels may auto-register a new group (e.g. allowlisting a DM by role).
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  // Symmetric removal — used when an allowlist condition stops holding.
  // Persistent state (folder, CLAUDE.md, accumulated context) is preserved.
  deregisterGroup: (jid: string) => void;
  // Auto-register a 1:1 DM when its sender resolves to a known KB person, so
  // any teammate can DM the bot without a per-DM admin step. Returns true when
  // the channel is (now) registered and the message should be processed; false
  // for unknown senders (still dropped). Channels call this for unregistered
  // DM channels before dropping. No-op / false for group channels.
  ensureDmRegistered?: (
    jid: string,
    platform: string,
    senderId: string,
  ) => boolean;
}

export type ChannelFactory = (opts: ChannelOpts) => Channel | null;

const registry = new Map<string, ChannelFactory>();

export function registerChannel(name: string, factory: ChannelFactory): void {
  registry.set(name, factory);
}

export function getChannelFactory(name: string): ChannelFactory | undefined {
  return registry.get(name);
}

export function getRegisteredChannelNames(): string[] {
  return [...registry.keys()];
}
