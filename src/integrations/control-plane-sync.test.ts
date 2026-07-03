import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const configMock = vi.hoisted(() => ({ DATA_DIR: '' }));
vi.mock('../config.js', () => configMock);

vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));

// In-memory stand-in for the DB layer the sync loop uses.
const dbState = vi.hoisted(() => ({
  cursor: 0,
  rows: [] as Array<Record<string, unknown>>,
}));
vi.mock('../db.js', () => ({
  getUsageReportCursor: vi.fn(() => dbState.cursor),
  setUsageReportCursor: vi.fn((c: number) => {
    dbState.cursor = c;
  }),
  getApiUsageSince: vi.fn((cursor: number, limit: number) =>
    dbState.rows.filter((r) => (r.id as number) > cursor).slice(0, limit),
  ),
}));

import {
  controlPlaneConfig,
  syncEntitlement,
  syncUsage,
} from './control-plane-sync.js';

// --- Test stub control-plane server ---------------------------------------

interface StubState {
  entitlementBody: unknown;
  entitlementStatus: number;
  usagePosts: Array<{ cursor: number; count: number }>;
  usageStatusFor: (call: number) => number; // 1-indexed call number → status
  usageCallCount: number;
}

let server: http.Server;
let baseUrl: string;
let stub: StubState;
let tmpDir: string;

function makeConfig() {
  return { url: baseUrl, token: 'test-token' };
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-sync-test-'));
  configMock.DATA_DIR = tmpDir;
  dbState.cursor = 0;
  dbState.rows = [];

  stub = {
    entitlementStatus: 200,
    entitlementBody: {
      state: 'active',
      plan: 'starter',
      monthlyTokenBudget: 50000,
      monthlyCostBudgetUsd: 20,
      periodStart: '2026-07-01T00:00:00.000Z',
      periodEnd: '2026-08-01T00:00:00.000Z',
    },
    usagePosts: [],
    usageCallCount: 0,
    usageStatusFor: () => 200,
  };

  server = http.createServer((req, res) => {
    // Assert auth on every request.
    if (req.headers['authorization'] !== 'Bearer test-token') {
      res.writeHead(401);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (req.url === '/api/instance/entitlement' && req.method === 'GET') {
        res.writeHead(stub.entitlementStatus, {
          'content-type': 'application/json',
        });
        res.end(JSON.stringify(stub.entitlementBody));
        return;
      }
      if (req.url === '/api/instance/usage' && req.method === 'POST') {
        stub.usageCallCount += 1;
        const status = stub.usageStatusFor(stub.usageCallCount);
        const parsed = JSON.parse(raw) as {
          cursor: number;
          events: Array<{ id: number }>;
        };
        stub.usagePosts.push({
          cursor: parsed.cursor,
          count: parsed.events.length,
        });
        if (status !== 200) {
          res.writeHead(status);
          res.end();
          return;
        }
        const lastId = parsed.events.length
          ? parsed.events[parsed.events.length - 1].id
          : parsed.cursor;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, cursor: lastId }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.CONTROL_PLANE_URL;
  delete process.env.CONTROL_PLANE_TOKEN;
});

function seedRows(n: number): void {
  dbState.rows = Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    runTag: null,
    model: 'claude-opus-4-8',
    inputTokens: 10,
    outputTokens: 5,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estCostUsd: 0.001,
    statusCode: 200,
    createdAt: '2026-07-01T00:00:00.000Z',
  }));
}

describe('controlPlaneConfig gating', () => {
  it('is null when env is absent (self-hosted mode)', () => {
    expect(controlPlaneConfig()).toBeNull();
  });

  it('reads url (trimmed of trailing slash) and token from env', () => {
    process.env.CONTROL_PLANE_URL = 'https://cloud.labor.fun/';
    process.env.CONTROL_PLANE_TOKEN = 'tok';
    expect(controlPlaneConfig()).toEqual({
      url: 'https://cloud.labor.fun',
      token: 'tok',
    });
  });
});

describe('syncEntitlement', () => {
  it('fetches and atomically writes entitlement.json with fetchedAt', async () => {
    const ok = await syncEntitlement(makeConfig());
    expect(ok).toBe(true);

    const file = path.join(tmpDir, 'entitlement.json');
    expect(fs.existsSync(file)).toBe(true);
    const written = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(written).toMatchObject({
      state: 'active',
      plan: 'starter',
      monthlyTokenBudget: 50000,
      monthlyCostBudgetUsd: 20,
    });
    expect(typeof written.fetchedAt).toBe('string');
    // No leftover tmp files.
    expect(fs.readdirSync(tmpDir).some((f) => f.includes('.tmp'))).toBe(false);
  });

  it('leaves the last cache in place on a non-200 (keeps continuity)', async () => {
    await syncEntitlement(makeConfig()); // write a good cache first
    const before = fs.readFileSync(
      path.join(tmpDir, 'entitlement.json'),
      'utf-8',
    );

    stub.entitlementStatus = 503;
    const ok = await syncEntitlement(makeConfig());
    expect(ok).toBe(false);
    const after = fs.readFileSync(
      path.join(tmpDir, 'entitlement.json'),
      'utf-8',
    );
    expect(after).toBe(before);
  });

  it('does not throw and returns false on a network error (bad host)', async () => {
    const ok = await syncEntitlement({
      url: 'http://127.0.0.1:1', // nothing listening
      token: 'test-token',
    });
    expect(ok).toBe(false);
  });
});

describe('syncUsage', () => {
  it('posts a single batch, advances the cursor, and drains', async () => {
    seedRows(3);
    await syncUsage(makeConfig());
    expect(stub.usagePosts).toEqual([{ cursor: 0, count: 3 }]);
    expect(dbState.cursor).toBe(3);
  });

  it('batches at 500 and loops until drained', async () => {
    seedRows(1201);
    await syncUsage(makeConfig());
    // 500 + 500 + 201 across three POSTs.
    expect(stub.usagePosts.map((p) => p.count)).toEqual([500, 500, 201]);
    expect(stub.usagePosts.map((p) => p.cursor)).toEqual([0, 500, 1000]);
    expect(dbState.cursor).toBe(1201);
  });

  it('no-ops when there is nothing to report', async () => {
    await syncUsage(makeConfig());
    expect(stub.usagePosts).toHaveLength(0);
    expect(dbState.cursor).toBe(0);
  });

  it('resumes from the persisted cursor after a failed batch', async () => {
    seedRows(1000);
    // Fail the SECOND POST; the first should have advanced the cursor to 500.
    stub.usageStatusFor = (call) => (call === 2 ? 500 : 200);

    await syncUsage(makeConfig());
    expect(dbState.cursor).toBe(500); // first batch committed, second failed
    expect(stub.usagePosts.map((p) => p.count)).toEqual([500, 500]);

    // Next tick: server healthy again → drains the remaining 500 from cursor 500.
    stub.usageStatusFor = () => 200;
    stub.usagePosts = [];
    await syncUsage(makeConfig());
    expect(stub.usagePosts).toEqual([{ cursor: 500, count: 500 }]);
    expect(dbState.cursor).toBe(1000);
  });

  it('does not throw on a network error and leaves the cursor untouched', async () => {
    seedRows(2);
    await syncUsage({ url: 'http://127.0.0.1:1', token: 'test-token' });
    expect(dbState.cursor).toBe(0);
  });
});
