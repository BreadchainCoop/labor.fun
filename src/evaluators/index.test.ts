import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { _closeDatabase, _initTestDatabase } from '../db.js';
import { searchKb } from '../kb-index.js';
import { NewMessage, RegisteredGroup } from '../types.js';
import { kbReindexEvaluator } from './kb-reindex.js';
import { requestLogEvaluator } from './request-log.js';
import { runEvaluators } from './index.js';
import { Evaluator, EvaluatorContext } from './types.js';

const GROUP: RegisteredGroup = {
  name: 'Test Group',
  folder: 'eval_test_group',
  trigger: '',
  added_at: '2026-01-01T00:00:00.000Z',
};

function msg(content: string, senderName = 'Alice'): NewMessage {
  return {
    id: `m-${content}`,
    chat_jid: 'slack:CTEST',
    sender: 'u1',
    sender_name: senderName,
    content,
    timestamp: '2026-05-29T12:00:00.000Z',
    is_from_me: false,
  } as NewMessage;
}

let groupDir: string;

function makeCtx(over: Partial<EvaluatorContext> = {}): EvaluatorContext {
  return {
    group: GROUP,
    chatJid: 'slack:CTEST',
    channel: 'slack',
    userMessages: [msg('hello there')],
    responseText: 'hi back',
    groupDir,
    contextDir: path.join(groupDir, 'context'),
    runId: 1,
    timestamp: '2026-05-29T12:00:05.000Z',
    ...over,
  };
}

describe('evaluators', () => {
  beforeEach(() => {
    _initTestDatabase();
    groupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'breadbrich-eval-'));
  });

  afterEach(() => {
    fs.rmSync(groupDir, { recursive: true, force: true });
    _closeDatabase();
  });

  describe('runEvaluators', () => {
    it('runs in priority order, lower first', async () => {
      const order: string[] = [];
      const mk = (name: string, priority: number): Evaluator => ({
        name,
        priority,
        validate: () => true,
        handler: async () => {
          order.push(name);
        },
      });
      const summary = await runEvaluators(makeCtx(), [
        mk('c', 30),
        mk('a', 10),
        mk('b', 20),
      ]);
      expect(order).toEqual(['a', 'b', 'c']);
      expect(summary.ran).toEqual(['a', 'b', 'c']);
    });

    it('skips evaluators whose validate returns false', async () => {
      let ran = false;
      const summary = await runEvaluators(makeCtx(), [
        {
          name: 'gated',
          validate: () => false,
          handler: async () => {
            ran = true;
          },
        },
      ]);
      expect(ran).toBe(false);
      expect(summary.skipped).toEqual(['gated']);
      expect(summary.ran).toEqual([]);
    });

    it('isolates a throwing evaluator and continues', async () => {
      const ran: string[] = [];
      const summary = await runEvaluators(makeCtx(), [
        {
          name: 'boom',
          priority: 1,
          validate: () => true,
          handler: async () => {
            throw new Error('kaboom');
          },
        },
        {
          name: 'ok',
          priority: 2,
          validate: () => true,
          handler: async () => {
            ran.push('ok');
          },
        },
      ]);
      expect(summary.failed).toEqual(['boom']);
      expect(summary.ran).toEqual(['ok']);
      expect(ran).toEqual(['ok']);
    });
  });

  describe('requestLogEvaluator', () => {
    it('creates the log with a header and appends one row per turn', async () => {
      const logPath = path.join(
        groupDir,
        'context',
        'artifacts',
        'request_log.md',
      );

      await requestLogEvaluator.handler(
        makeCtx({ userMessages: [msg('first request', 'Bob')] }),
      );
      await requestLogEvaluator.handler(
        makeCtx({ userMessages: [msg('second request', 'Carol')] }),
      );

      const body = fs.readFileSync(logPath, 'utf8');
      expect(body).toContain('visibility: restricted');
      expect(body).toContain('| Date | User | Channel | Summary | Status |');
      // Header line is directly followed by rows (no blank line breaking the table).
      expect(body).toContain(
        '| 2026-05-29 | Bob | Slack | first request | Completed |',
      );
      expect(body).toContain(
        '| 2026-05-29 | Carol | Slack | second request | Completed |',
      );
      const dataRows = body
        .split('\n')
        .filter((l) => l.startsWith('| 2026-05-29 |'));
      expect(dataRows.length).toBe(2);
    });

    it('marks status Pending when no response text was sent', async () => {
      await requestLogEvaluator.handler(makeCtx({ responseText: '' }));
      const body = fs.readFileSync(
        path.join(groupDir, 'context', 'artifacts', 'request_log.md'),
        'utf8',
      );
      expect(body).toContain('| Pending |');
    });

    it('escapes pipes so user content cannot break the table', async () => {
      await requestLogEvaluator.handler(
        makeCtx({ userMessages: [msg('a | b | c')] }),
      );
      const body = fs.readFileSync(
        path.join(groupDir, 'context', 'artifacts', 'request_log.md'),
        'utf8',
      );
      expect(body).not.toContain('a | b | c');
      expect(body).toContain('a / b / c');
    });

    it('does not validate when there are no user messages', () => {
      expect(requestLogEvaluator.validate(makeCtx({ userMessages: [] }))).toBe(
        false,
      );
    });
  });

  describe('kbReindexEvaluator', () => {
    it('indexes KB written this turn so it is immediately searchable', async () => {
      const contextDir = path.join(groupDir, 'context');
      fs.mkdirSync(path.join(contextDir, 'people'), { recursive: true });
      fs.writeFileSync(
        path.join(contextDir, 'people', 'dave.md'),
        '## Role\nDave coordinates logistics.',
      );

      const ctx = makeCtx({ contextDir });
      expect(kbReindexEvaluator.validate(ctx)).toBe(true);
      await kbReindexEvaluator.handler(ctx);

      const hits = searchKb('logistics', { groupFolder: GROUP.folder });
      expect(hits.length).toBe(1);
    });

    it('does not validate when the context dir is absent', () => {
      const ctx = makeCtx({ contextDir: path.join(groupDir, 'nope') });
      expect(kbReindexEvaluator.validate(ctx)).toBe(false);
    });
  });
});
