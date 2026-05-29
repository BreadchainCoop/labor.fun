/**
 * request-log evaluator.
 *
 * Enforces `rules/knowledge-base/request-logging.md` ("Mandatory after EVERY
 * interaction") deterministically. Previously this depended on the container
 * agent remembering to append a row; now the orchestrator guarantees it,
 * appending one line per turn to `context/artifacts/request_log.md` in the
 * format the dashboard already expects.
 */
import fs from 'fs';
import path from 'path';

import { logger } from '../logger.js';
import { EvaluatorContext, Evaluator } from './types.js';

const LOG_REL_PATH = path.join('artifacts', 'request_log.md');

const TABLE_HEADER = [
  '| Date | User | Channel | Summary | Status |',
  '|------|------|---------|---------|--------|',
].join('\n');

/** Collapse to a single line and clamp length for the one-line Summary cell. */
function oneLine(text: string, max = 140): string {
  const collapsed = text
    .replace(/\|/g, '/') // never break the markdown table
    .replace(/\s+/g, ' ')
    .trim();
  if (collapsed.length <= max) return collapsed;
  return collapsed.slice(0, max - 1) + '…';
}

function channelLabel(channel: string): string {
  switch (channel) {
    case 'slack':
      return 'Slack';
    case 'telegram':
      return 'Telegram';
    case 'discord':
      return 'Discord';
    case 'cli':
      return 'CLI';
    default:
      return channel || 'Unknown';
  }
}

export const requestLogEvaluator: Evaluator = {
  name: 'request-log',
  priority: 10,

  validate(ctx: EvaluatorContext): boolean {
    // Only log turns that had real user input.
    return ctx.userMessages.length > 0;
  },

  async handler(ctx: EvaluatorContext): Promise<void> {
    const last = ctx.userMessages[ctx.userMessages.length - 1];
    const date = ctx.timestamp.slice(0, 10); // YYYY-MM-DD
    const user = last?.sender_name?.trim() || 'unknown';
    const summarySource =
      ctx.userMessages
        .map((m) => m.content)
        .join(' ')
        .trim() || '(no text)';
    const status = ctx.responseText.trim() ? 'Completed' : 'Pending';

    const row = `| ${date} | ${oneLine(user, 40)} | ${channelLabel(
      ctx.channel,
    )} | ${oneLine(summarySource)} | ${status} |`;

    const logPath = path.join(ctx.contextDir, LOG_REL_PATH);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });

    if (!fs.existsSync(logPath)) {
      const preamble = [
        '---',
        'title: Request Log',
        'visibility: restricted',
        '---',
        '',
        '# Request Log',
        '',
        'Auto-appended by the request-log evaluator after every interaction.',
        '',
        TABLE_HEADER,
        '', // trailing newline; rows are appended directly under the header
      ].join('\n');
      // No blank line between the header and the first row — a blank line
      // would terminate the markdown table.
      fs.writeFileSync(logPath, preamble);
    }

    fs.appendFileSync(logPath, row + '\n');
    logger.debug(
      { group: ctx.group.folder, logPath },
      'request-log: appended interaction row',
    );
  },
};
