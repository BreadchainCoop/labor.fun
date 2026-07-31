/**
 * In-memory sliding-window rate limiter.
 *
 * Used to throttle pre-agent chat-command spam (src/chat-commands.ts). An
 * in-memory limiter is sufficient: labor.fun is a single Node process (see
 * CLAUDE.md), so there is no cross-process limiter to coordinate.
 *
 * The core `check()` is a pure-ish function: it accepts an explicit `now`
 * (defaulting to Date.now()) so tests can drive a fixed clock and the
 * window-expiry logic is deterministic.
 */

export interface RateLimitResult {
  /** True if this event is allowed (under the limit); false if it should be dropped. */
  allowed: boolean;
  /** Number of events counted in the window AFTER this check. */
  count: number;
  /**
   * True only on the FIRST denial within a contiguous over-limit window — i.e.
   * the transition from allowed→denied for this key. Used to send a one-time
   * throttle notice instead of spamming the notice on every denied message.
   */
  firstDenial: boolean;
}

interface KeyState {
  /** Timestamps (ms) of allowed events still inside the current window. */
  timestamps: number[];
  /** Whether a throttle notice has already been emitted for the current over-limit window. */
  notified: boolean;
  /** Last time this key saw any activity — used for stale-key pruning. */
  lastSeen: number;
}

export class RateLimiter {
  private readonly keys = new Map<string, KeyState>();

  /**
   * Record an event for `key` and decide whether it is allowed.
   *
   * Sliding window: timestamps older than `windowMs` are discarded; if the
   * remaining count is below `max`, the event is allowed and its timestamp is
   * recorded. Otherwise it is denied (and no timestamp is recorded, so a
   * single offender cannot indefinitely push the window forward).
   *
   * @param key      Stable key, e.g. `${chatJid}|${sender}|${command}`.
   * @param windowMs Sliding window length in milliseconds.
   * @param max      Max allowed events within the window.
   * @param now      Current time in ms (injectable for tests).
   */
  check(
    key: string,
    windowMs: number,
    max: number,
    now: number = Date.now(),
  ): RateLimitResult {
    let state = this.keys.get(key);
    if (!state) {
      state = { timestamps: [], notified: false, lastSeen: now };
      this.keys.set(key, state);
    }
    state.lastSeen = now;

    // Drop timestamps that have aged out of the window.
    const cutoff = now - windowMs;
    state.timestamps = state.timestamps.filter((t) => t > cutoff);

    if (state.timestamps.length < max) {
      // Under the limit → allow, record, and reset the one-time-notice flag so a
      // future over-limit window can notify again.
      state.timestamps.push(now);
      state.notified = false;
      return {
        allowed: true,
        count: state.timestamps.length,
        firstDenial: false,
      };
    }

    // Over the limit → deny. firstDenial is true only on the allowed→denied
    // transition (the first denied event in this over-limit window).
    const firstDenial = !state.notified;
    if (firstDenial) state.notified = true;
    return {
      allowed: false,
      count: state.timestamps.length,
      firstDenial,
    };
  }

  /**
   * Remove keys with no activity for at least `maxIdleMs`, to bound memory.
   * Safe to call periodically; returns the number of keys pruned.
   */
  prune(maxIdleMs: number, now: number = Date.now()): number {
    let pruned = 0;
    const cutoff = now - maxIdleMs;
    for (const [key, state] of this.keys) {
      if (state.lastSeen <= cutoff) {
        this.keys.delete(key);
        pruned++;
      }
    }
    return pruned;
  }

  /** Number of tracked keys (for diagnostics/tests). */
  size(): number {
    return this.keys.size;
  }

  /** Drop all state (for tests). */
  clear(): void {
    this.keys.clear();
  }
}

/** Build a limiter key from the (chatJid, sender, command) tuple. */
export function rateLimitKey(
  chatJid: string,
  sender: string,
  command: string,
): string {
  return `${chatJid}|${sender}|${command}`;
}

/**
 * Shared process-wide limiter instance for chat-command throttling.
 * A periodic prune (wired in src/index.ts via setInterval → prune()) keeps
 * stale keys from accumulating across long uptimes.
 */
export const slashCommandLimiter = new RateLimiter();
