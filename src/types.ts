export interface AdditionalMount {
  hostPath: string; // Absolute path on host (supports ~ for home)
  containerPath?: string; // Optional — defaults to basename of hostPath. Mounted at /workspace/extra/{value}
  readonly?: boolean; // Default: true for safety
}

/**
 * Mount Allowlist - Security configuration for additional mounts
 * This file should be stored at ~/.config/nanoclaw/mount-allowlist.json
 * and is NOT mounted into any container, making it tamper-proof from agents.
 */
export interface MountAllowlist {
  // Directories that can be mounted into containers
  allowedRoots: AllowedRoot[];
  // Glob patterns for paths that should never be mounted (e.g., ".ssh", ".gnupg")
  blockedPatterns: string[];
  // If true, non-main groups can only mount read-only regardless of config
  nonMainReadOnly: boolean;
}

export interface AllowedRoot {
  // Absolute path or ~ for home (e.g., "~/projects", "/var/repos")
  path: string;
  // Whether read-write mounts are allowed under this root
  allowReadWrite: boolean;
  // Optional description for documentation
  description?: string;
}

export interface ContainerConfig {
  additionalMounts?: AdditionalMount[];
  timeout?: number; // Default: 300000 (5 minutes)
}

export interface RegisteredGroup {
  name: string;
  folder: string;
  trigger: string;
  added_at: string;
  containerConfig?: ContainerConfig;
  requiresTrigger?: boolean; // Default: true for groups, false for solo chats
  isMain?: boolean; // True for the main control group (no trigger, elevated privileges)
}

export interface NewMessage {
  id: string;
  chat_jid: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me?: boolean;
  is_bot_message?: boolean;
  thread_id?: string;
  reply_to_message_id?: string;
  reply_to_message_content?: string;
  reply_to_sender_name?: string;
  is_reply_to_bot?: boolean;
  user_id?: string; // Resolved KB person ID (e.g., 'jane-doe')
}

export interface ScheduledTask {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  script?: string | null;
  schedule_type: 'cron' | 'interval' | 'once';
  schedule_value: string;
  context_mode: 'group' | 'isolated';
  next_run: string | null;
  last_run: string | null;
  last_result: string | null;
  status: 'active' | 'paused' | 'completed';
  created_at: string;
}

export interface TaskRunLog {
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: 'success' | 'error';
  result: string | null;
  error: string | null;
}

// --- Channel abstraction ---

export interface SendMessageOpts {
  /**
   * ID of the inbound message this send is replying to. Thread-aware channels
   * (Discord threads, Slack threads, Telegram forum topics) use it to route
   * the reply into that specific message's thread/topic, instead of a
   * per-channel "last inbound" anchor that a concurrent message in another
   * thread can overwrite between the trigger and the reply (which posted
   * answers in the wrong thread under concurrent load). Omitted for
   * proactive/agent-initiated sends, which fall back to channel-level routing.
   */
  replyToMessageId?: string;
  /**
   * Proactive / scheduled send with no triggering inbound message. When true,
   * thread-aware channels post to the BASE channel and never anchor to (or
   * start a thread on) a prior inbound — a scheduled task's output must not
   * reply to whoever happened to message last. Interactive replies pass
   * `replyToMessageId` instead and keep threading.
   */
  standalone?: boolean;
}

export interface Channel {
  name: string;
  connect(): Promise<void>;
  /**
   * Deliver a message to `jid`. Resolves `true` when the message was delivered
   * (or accepted for guaranteed later delivery, e.g. queued while briefly
   * disconnected) and `false` when it was dropped or failed to send (channel
   * not connected, target unreachable, API error). Callers that only reply into
   * the current chat may ignore the result; the cross-channel IPC path relies
   * on it to surface silent non-delivery instead of reporting a false success.
   */
  sendMessage(
    jid: string,
    text: string,
    opts?: SendMessageOpts,
  ): Promise<boolean>;
  isConnected(): boolean;
  ownsJid(jid: string): boolean;
  disconnect(): Promise<void>;
  // Optional: typing indicator. Channels that support it implement it.
  setTyping?(jid: string, isTyping: boolean): Promise<void>;
  // Optional: sync group/chat names from the platform.
  syncGroups?(force: boolean): Promise<void>;
  // Optional: update a previously sent message in place (for ACK → progress → final answer)
  updateStatus?(jid: string, messageId: string, text: string): Promise<void>;
  // Optional: delete a previously sent message
  deleteMessage?(jid: string, messageId: string): Promise<void>;
  // Optional: send a message and return its ID for later editing/deletion
  sendMessageWithId?(jid: string, text: string): Promise<string | undefined>;
  // Optional: add an emoji reaction to a message
  addReaction?(jid: string, messageId: string, emoji: string): Promise<void>;
  // Optional: remove an emoji reaction from a message
  removeReaction?(jid: string, messageId: string, emoji: string): Promise<void>;
}

// Callback type that channels use to deliver inbound messages
export type OnInboundMessage = (chatJid: string, message: NewMessage) => void;

// Callback for chat metadata discovery.
// name is optional — channels that deliver names inline (Telegram) pass it here;
// channels that sync names separately (via syncGroups) omit it.
export type OnChatMetadata = (
  chatJid: string,
  timestamp: string,
  name?: string,
  channel?: string,
  isGroup?: boolean,
) => void;
