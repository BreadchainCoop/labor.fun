import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { getAllRegisteredGroups, getDb } from './db.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';

const DEFAULT_DIGEST_DIR_NAME = 'group_digests';
const RECENT_MESSAGE_LIMIT = 5;
const RECENT_MESSAGE_PREVIEW_CHARS = 200;
const HOUR_MS = 60 * 60 * 1000;

interface RecentMessage {
  sender_name: string;
  content: string;
  timestamp: string;
  is_bot_message: number;
}

interface MessageStats {
  total: number;
  fromUsers: number;
  fromBot: number;
}

function getStatsForChatJid(chatJid: string, sinceIso: string): MessageStats {
  // messages.timestamp is stored as ISO 8601 strings by all channels
  // (src/channels/{slack,telegram}.ts both call .toISOString()), so
  // lexical string comparison is a correct chronological filter.
  const row = getDb()
    .prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN is_bot_message = 0 AND is_from_me = 0 THEN 1 ELSE 0 END) AS fromUsers,
         SUM(CASE WHEN is_bot_message = 1 THEN 1 ELSE 0 END) AS fromBot
       FROM messages
       WHERE chat_jid = ? AND timestamp >= ?`,
    )
    .get(chatJid, sinceIso) as
    | { total: number; fromUsers: number | null; fromBot: number | null }
    | undefined;
  return {
    total: row?.total ?? 0,
    fromUsers: row?.fromUsers ?? 0,
    fromBot: row?.fromBot ?? 0,
  };
}

function getRecentMessages(chatJid: string, limit: number): RecentMessage[] {
  return getDb()
    .prepare(
      `SELECT sender_name, content, timestamp, is_bot_message
       FROM messages
       WHERE chat_jid = ?
       ORDER BY timestamp DESC
       LIMIT ?`,
    )
    .all(chatJid, limit) as RecentMessage[];
}

function getClaudeMdMtime(folder: string): number | null {
  try {
    const p = path.join(resolveGroupFolderPath(folder), 'CLAUDE.md');
    if (!fs.existsSync(p)) return null;
    return fs.statSync(p).mtimeMs;
  } catch {
    return null;
  }
}

function formatPreview(content: string): string {
  const collapsed = content.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= RECENT_MESSAGE_PREVIEW_CHARS) return collapsed;
  return collapsed.slice(0, RECENT_MESSAGE_PREVIEW_CHARS) + '…';
}

function buildDigest(
  folder: string,
  name: string,
  chatJid: string,
  windowStartMs: number,
  generatedAt: string,
): string {
  const windowStartIso = new Date(windowStartMs).toISOString();
  const stats = getStatsForChatJid(chatJid, windowStartIso);
  const recent = getRecentMessages(chatJid, RECENT_MESSAGE_LIMIT);
  const claudeMdMtime = getClaudeMdMtime(folder);
  const claudeMdChanged =
    claudeMdMtime !== null && claudeMdMtime >= windowStartMs;

  const frontmatter = [
    '---',
    `group_folder: ${folder}`,
    `group_name: ${name}`,
    `chat_jid: ${chatJid}`,
    `generated_at: ${generatedAt}`,
    `window_start: ${windowStartIso}`,
    `messages_last_hour: ${stats.total}`,
    `from_users_last_hour: ${stats.fromUsers}`,
    `from_bot_last_hour: ${stats.fromBot}`,
    `claude_md_changed_in_window: ${claudeMdChanged}`,
    '---',
  ].join('\n');

  const recentBlock = recent.length
    ? recent
        .reverse()
        .map((m) => {
          const tag = m.is_bot_message ? '[bot]' : '';
          return `- ${m.timestamp} ${tag} **${m.sender_name}**: ${formatPreview(m.content)}`;
        })
        .join('\n')
    : '_no recent messages_';

  return `${frontmatter}\n\n# ${name} — group digest\n\n## Last hour\n\n- Total messages: ${stats.total} (${stats.fromUsers} from users, ${stats.fromBot} from bot)\n- CLAUDE.md changed in this window: ${claudeMdChanged ? 'yes' : 'no'}\n\n## Recent messages (last ${recent.length})\n\n${recentBlock}\n`;
}

let digestRunning = false;

export async function writeAllGroupDigests(
  digestRoot: string,
): Promise<{ written: number; skipped: number }> {
  const groups = getAllRegisteredGroups();
  const now = Date.now();
  const windowStartMs = now - HOUR_MS;
  const generatedAt = new Date(now).toISOString();

  fs.mkdirSync(digestRoot, { recursive: true });

  let written = 0;
  let skipped = 0;

  for (const [chatJid, group] of Object.entries(groups)) {
    if (group.isMain) {
      skipped++;
      continue;
    }
    try {
      const body = buildDigest(
        group.folder,
        group.name,
        chatJid,
        windowStartMs,
        generatedAt,
      );
      const outPath = path.join(digestRoot, `${group.folder}.md`);
      const tmpPath = `${outPath}.tmp`;
      fs.writeFileSync(tmpPath, body);
      fs.renameSync(tmpPath, outPath);
      written++;
    } catch (err) {
      logger.warn(
        { err, folder: group.folder, chatJid },
        'Group digest write failed',
      );
      skipped++;
    }
  }

  return { written, skipped };
}

export function startGroupDigestLoop(opts?: {
  intervalMs?: number;
  digestRoot?: string;
}): void {
  if (digestRunning) {
    logger.debug('Group digest loop already running');
    return;
  }
  digestRunning = true;

  const interval = opts?.intervalMs ?? HOUR_MS;
  // Default to data/group_digests/ (outside groups/) so digests are NOT
  // exposed to non-main containers via the shared-kb mount, which mounts
  // groups/<shared-kb> read-only into every group. Digests contain
  // cross-group message previews and must only be readable by main, which
  // sees them via the existing projectRoot mount at /workspace/project.
  const digestRoot =
    opts?.digestRoot ?? path.join(DATA_DIR, DEFAULT_DIGEST_DIR_NAME);

  logger.info(
    { intervalMs: interval, digestRoot },
    'Group digest loop started',
  );

  const tick = async () => {
    try {
      const result = await writeAllGroupDigests(digestRoot);
      logger.info(result, 'Group digests written');
    } catch (err) {
      logger.error({ err }, 'Group digest tick failed');
    }
    setTimeout(tick, interval);
  };

  // Stagger first run by 60s to let the orchestrator finish startup
  setTimeout(tick, 60_000);
}

/** @internal — for tests only */
export function _resetDigestLoopForTests(): void {
  digestRunning = false;
}
