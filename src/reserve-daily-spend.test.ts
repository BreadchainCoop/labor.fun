/**
 * reserve-daily-spend.test.ts — the daily estimated-spend cap primitive
 * (src/spend-gate.ts). Uses the real in-memory DB via _initTestDatabase so
 * the passive_monitor_spend ledger DDL in createSchema is what's under test.
 * The primitive takes an explicit db+now, so no config mock is needed.
 */

import { describe, it, expect, beforeEach } from 'vitest';

import { _initTestDatabase, getDb } from './db.js';
import { reserveDailySpend } from './spend-gate.js';

beforeEach(() => {
  _initTestDatabase();
});

const DAY1 = Date.parse('2026-03-10T12:00:00Z');
const DAY1_LATE = Date.parse('2026-03-10T23:59:00Z');
const DAY2 = Date.parse('2026-03-11T00:01:00Z');

describe('reserveDailySpend: reservation accounting', () => {
  it('reserves until the cap, then denies without refunding', () => {
    const db = getDb();
    const cap = 1.0;
    const est = 0.4;
    // 0.4 + 0.4 = 0.8 <= 1.0 → both allowed; third (1.2) denied.
    expect(reserveDailySpend(db, cap, est, DAY1).allowed).toBe(true);
    expect(reserveDailySpend(db, cap, est, DAY1).allowed).toBe(true);
    const third = reserveDailySpend(db, cap, est, DAY1);
    expect(third.allowed).toBe(false);
    expect(third.reason).toBe('cap-exhausted');
    // The ledger holds the two reservations, not three (non-refundable, and the
    // denied one reserved nothing).
    const row = db
      .prepare(
        `SELECT reserved_usd, batches FROM passive_monitor_spend WHERE spend_date='2026-03-10'`,
      )
      .get() as { reserved_usd: number; batches: number };
    expect(row.reserved_usd).toBeCloseTo(0.8, 6);
    expect(row.batches).toBe(2);
  });

  it('resets on the UTC day boundary', () => {
    const db = getDb();
    const cap = 0.5;
    const est = 0.5;
    // Day 1: one reservation fills the cap.
    expect(reserveDailySpend(db, cap, est, DAY1).allowed).toBe(true);
    expect(reserveDailySpend(db, cap, est, DAY1_LATE).allowed).toBe(false);
    // Day 2 (new UTC date): a fresh budget.
    expect(reserveDailySpend(db, cap, est, DAY2).allowed).toBe(true);
    expect(reserveDailySpend(db, cap, est, DAY2).allowed).toBe(false);
  });

  it('never lets the total reserved estimate exceed the cap (conservative under float drift)', () => {
    const db = getDb();
    const cap = 1.0;
    let allowed = 0;
    for (let i = 0; i < 100; i++) {
      if (reserveDailySpend(db, cap, 0.05, DAY1).allowed) allowed++;
    }
    // ~20 batches fit under a $1 cap at $0.05 each; float accumulation may stop
    // one short (19) — that is the SAFE direction (under-spend, never over).
    expect(allowed).toBeGreaterThanOrEqual(19);
    expect(allowed).toBeLessThanOrEqual(20);
    const row = db
      .prepare(
        `SELECT reserved_usd FROM passive_monitor_spend WHERE spend_date='2026-03-10'`,
      )
      .get() as { reserved_usd: number };
    // The ceiling is NEVER exceeded.
    expect(row.reserved_usd).toBeLessThanOrEqual(cap);
  });
});

describe('reserveDailySpend: fail closed', () => {
  it('denies on a missing/zero/negative/NaN cap without reserving', () => {
    const db = getDb();
    for (const badCap of [0, -1, NaN]) {
      const r = reserveDailySpend(db, badCap, 0.05, DAY1);
      expect(r.allowed).toBe(false);
      expect(r.reason).toBe('invalid-cap');
    }
    // Nothing was reserved.
    expect(
      db.prepare(`SELECT COUNT(*) c FROM passive_monitor_spend`).get(),
    ).toEqual({ c: 0 });
  });

  it('denies on a non-positive/NaN estimate without reserving', () => {
    const db = getDb();
    for (const badEst of [0, -0.1, NaN]) {
      const r = reserveDailySpend(db, 1.0, badEst, DAY1);
      expect(r.allowed).toBe(false);
      expect(r.reason).toBe('invalid-estimate');
    }
  });

  it('denies (does not throw) when the ledger table is missing (DB error)', () => {
    const db = getDb();
    db.exec('DROP TABLE passive_monitor_spend');
    const r = reserveDailySpend(db, 1.0, 0.05, DAY1);
    expect(r.allowed).toBe(false);
    expect(r.reason).toBe('db-error');
  });
});
