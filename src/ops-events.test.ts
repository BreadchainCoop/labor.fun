/**
 * Tests for the ops_events audit rail (src/db.ts): DDL + logOpsEvent() +
 * readers. Substrate only — later waves (IPC dead-letter, passive monitor)
 * write to it; this wave proves the shape and round-trip semantics.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import {
  _initTestDatabase,
  getOpsEventsSince,
  getRecentOpsEvents,
  logOpsEvent,
} from './db.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('ops_events', () => {
  it('inserts and reads back a generic ops event', () => {
    const id = logOpsEvent({
      eventType: 'system',
      source: 'test',
      summary: 'hello',
      detail: { a: 1 },
    });
    expect(id).toBeGreaterThan(0);
    const rows = getRecentOpsEvents();
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe('system');
    expect(rows[0].source).toBe('test');
    expect(rows[0].severity).toBe('info'); // default severity
    expect(rows[0].summary).toBe('hello');
    expect(rows[0].created_at).toBeTruthy();
  });

  it('round-trips metadata JSON through the detail column', () => {
    const detail = {
      nested: { list: [1, 2, 3], flag: true },
      text: 'unicode ✓ / "quotes"',
      nothing: null,
    };
    logOpsEvent({ eventType: 'devops', source: 't', summary: 's', detail });
    const row = getRecentOpsEvents()[0];
    expect(JSON.parse(row.detail!)).toEqual(detail);
  });

  it('stores NULL detail when no metadata is passed', () => {
    logOpsEvent({ eventType: 'system', source: 't', summary: 'bare' });
    expect(getRecentOpsEvents()[0].detail).toBeNull();
  });

  it('persists optional ref_id / actor / severity', () => {
    logOpsEvent({
      eventType: 'container',
      source: 'container-runner',
      severity: 'critical',
      refId: 'run-42',
      actor: 'orchestrator',
      summary: 'container exploded',
    });
    const row = getRecentOpsEvents()[0];
    expect(row.severity).toBe('critical');
    expect(row.ref_id).toBe('run-42');
    expect(row.actor).toBe('orchestrator');
  });

  it('bounds the summary to 500 chars', () => {
    logOpsEvent({ eventType: 'system', source: 't', summary: 'x'.repeat(900) });
    expect(getRecentOpsEvents()[0].summary).toHaveLength(500);
  });

  it('filters by type and severity', () => {
    logOpsEvent({ eventType: 'devops', source: 't', summary: 'a' });
    logOpsEvent({
      eventType: 'container',
      source: 't',
      severity: 'critical',
      summary: 'b',
    });
    expect(getRecentOpsEvents({ eventType: 'container' })).toHaveLength(1);
    expect(getRecentOpsEvents({ severity: 'critical' })).toHaveLength(1);
    expect(getRecentOpsEvents({ eventType: 'deploy' })).toHaveLength(0);
  });

  it('getOpsEventsSince returns rows at/after the cutoff', () => {
    logOpsEvent({ eventType: 'system', source: 't', summary: 'now' });
    expect(getOpsEventsSince('1970-01-01T00:00:00.000Z')).toHaveLength(1);
    expect(getOpsEventsSince('2999-01-01T00:00:00.000Z')).toHaveLength(0);
  });

  it('returns ids in insert order and monotonic', () => {
    const a = logOpsEvent({ eventType: 'system', source: 't', summary: '1' });
    const b = logOpsEvent({ eventType: 'system', source: 't', summary: '2' });
    expect(b).toBeGreaterThan(a);
  });
});
