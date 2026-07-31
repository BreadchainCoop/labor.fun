import { describe, it, expect } from 'vitest';

import { RateLimiter, rateLimitKey } from './rate-limit.js';

const WINDOW = 30000;
const MAX = 5;
const KEY = 'tg:100|99001|hardware';

describe('RateLimiter', () => {
  describe('check — sliding window', () => {
    it('allows up to `max` events within the window', () => {
      const rl = new RateLimiter();
      for (let i = 0; i < MAX; i++) {
        const r = rl.check(KEY, WINDOW, MAX, 1000 + i);
        expect(r.allowed).toBe(true);
        expect(r.count).toBe(i + 1);
        expect(r.firstDenial).toBe(false);
      }
    });

    it('denies the (max + 1)th event within the window', () => {
      const rl = new RateLimiter();
      for (let i = 0; i < MAX; i++) rl.check(KEY, WINDOW, MAX, 1000 + i);

      const denied = rl.check(KEY, WINDOW, MAX, 1000 + MAX);
      expect(denied.allowed).toBe(false);
      expect(denied.count).toBe(MAX); // denied events are not recorded
    });

    it('does not record denied events (offender cannot push the window forward)', () => {
      const rl = new RateLimiter();
      for (let i = 0; i < MAX; i++) rl.check(KEY, WINDOW, MAX, 1000);
      // Many denials, all at the same instant — count stays pinned at max.
      for (let i = 0; i < 10; i++) {
        const r = rl.check(KEY, WINDOW, MAX, 1000);
        expect(r.allowed).toBe(false);
        expect(r.count).toBe(MAX);
      }
    });

    it('resets the count once events age out of the window', () => {
      const rl = new RateLimiter();
      const start = 1000;
      for (let i = 0; i < MAX; i++) rl.check(KEY, WINDOW, MAX, start);
      expect(rl.check(KEY, WINDOW, MAX, start).allowed).toBe(false);

      // Move past the window: all prior timestamps expire, count resets.
      const later = start + WINDOW + 1;
      const r = rl.check(KEY, WINDOW, MAX, later);
      expect(r.allowed).toBe(true);
      expect(r.count).toBe(1);
    });

    it('expires only events older than the window (partial slide)', () => {
      const rl = new RateLimiter();
      // 5 events at t=1000..1004 fill the window.
      for (let i = 0; i < MAX; i++) rl.check(KEY, WINDOW, MAX, 1000 + i);
      // At t = 1000 + WINDOW + 1, the t=1000 event has expired (>WINDOW old)
      // but t=1001..1004 are still in-window → one slot frees up.
      const r = rl.check(KEY, WINDOW, MAX, 1000 + WINDOW + 1);
      expect(r.allowed).toBe(true);
    });

    it('keys are independent', () => {
      const rl = new RateLimiter();
      const a = rateLimitKey('tg:1', 'u1', 'cmd');
      const b = rateLimitKey('tg:1', 'u2', 'cmd');
      for (let i = 0; i < MAX; i++) rl.check(a, WINDOW, MAX, 1000);
      expect(rl.check(a, WINDOW, MAX, 1000).allowed).toBe(false);
      // Different sender → fresh budget.
      expect(rl.check(b, WINDOW, MAX, 1000).allowed).toBe(true);
    });

    it('defaults `now` to Date.now() when omitted', () => {
      const rl = new RateLimiter();
      const r = rl.check(KEY, WINDOW, MAX);
      expect(r.allowed).toBe(true);
      expect(r.count).toBe(1);
    });
  });

  describe('one-time notice flag (firstDenial)', () => {
    it('fires firstDenial exactly once per over-limit window', () => {
      const rl = new RateLimiter();
      for (let i = 0; i < MAX; i++) rl.check(KEY, WINDOW, MAX, 1000);

      const first = rl.check(KEY, WINDOW, MAX, 1000);
      expect(first.allowed).toBe(false);
      expect(first.firstDenial).toBe(true);

      // Subsequent denials in the same window do NOT re-fire the notice.
      for (let i = 0; i < 5; i++) {
        const r = rl.check(KEY, WINDOW, MAX, 1000);
        expect(r.allowed).toBe(false);
        expect(r.firstDenial).toBe(false);
      }
    });

    it('re-arms firstDenial after the window resets and is exceeded again', () => {
      const rl = new RateLimiter();
      const start = 1000;
      for (let i = 0; i < MAX; i++) rl.check(KEY, WINDOW, MAX, start);
      expect(rl.check(KEY, WINDOW, MAX, start).firstDenial).toBe(true);

      // New window: an allowed event clears the notified flag.
      const later = start + WINDOW + 1;
      for (let i = 0; i < MAX; i++) rl.check(KEY, WINDOW, MAX, later);
      // Exceed again → notice re-fires.
      expect(rl.check(KEY, WINDOW, MAX, later).firstDenial).toBe(true);
    });
  });

  describe('admin-bypass is a call-site concern', () => {
    // The limiter is intentionally unaware of admin status — channels check
    // `isSenderAdmin(...)` BEFORE calling check(), so an admin's commands never
    // reach the limiter and never consume budget. We assert that property by
    // simulating the call-site guard.
    it('admin commands never touch the limiter (no budget consumed)', () => {
      const rl = new RateLimiter();
      const isAdmin = (sender: string) => sender === 'admin-1';

      const handle = (sender: string) => {
        if (isAdmin(sender)) return { allowed: true, viaLimiter: false };
        const r = rl.check(
          rateLimitKey('tg:1', sender, 'cmd'),
          WINDOW,
          MAX,
          1000,
        );
        return { allowed: r.allowed, viaLimiter: true };
      };

      // Admin spams 100 times — always allowed, limiter untouched for that key.
      for (let i = 0; i < 100; i++) {
        const r = handle('admin-1');
        expect(r.allowed).toBe(true);
        expect(r.viaLimiter).toBe(false);
      }
      // Non-admin still gets throttled normally.
      for (let i = 0; i < MAX; i++) expect(handle('user-1').allowed).toBe(true);
      expect(handle('user-1').allowed).toBe(false);
    });
  });

  describe('prune', () => {
    it('removes stale keys past the idle threshold', () => {
      const rl = new RateLimiter();
      rl.check('a', WINDOW, MAX, 1000);
      rl.check('b', WINDOW, MAX, 5000);
      expect(rl.size()).toBe(2);

      // Prune keys idle for >= 2000ms, evaluated at t=6000.
      // 'a' lastSeen=1000 (idle 5000 ≥ 2000) → pruned; 'b' lastSeen=5000 (idle 1000) → kept.
      const pruned = rl.prune(2000, 6000);
      expect(pruned).toBe(1);
      expect(rl.size()).toBe(1);
    });

    it('keeps recently-active keys', () => {
      const rl = new RateLimiter();
      rl.check('a', WINDOW, MAX, 1000);
      const pruned = rl.prune(WINDOW, 1500);
      expect(pruned).toBe(0);
      expect(rl.size()).toBe(1);
    });
  });

  describe('rateLimitKey', () => {
    it('builds a stable composite key', () => {
      expect(rateLimitKey('tg:100', '99001', 'hardware')).toBe(
        'tg:100|99001|hardware',
      );
    });
  });
});
