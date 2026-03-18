/**
 * @file tests/unit/rate-limiter.test.ts
 * @description Unit tests for {@link RateLimiter} from src/finnhub/rate-limiter.ts.
 *
 * All tests use `vi.useFakeTimers()` so that `Date.now()` and `setTimeout`
 * are fully controlled without real wall-clock delays.  Fake timers are
 * restored in an `afterEach` hook so individual test failures cannot bleed
 * into subsequent tests.
 *
 * ## Test coverage
 * 1. Hard ceiling — the 56th enqueued call is deferred until the 60-second
 *    window resets.
 * 2. Priority ordering — when both a priority-4 and a priority-1 item are
 *    queued while the ceiling is active, priority-1 is dispatched first after
 *    the window resets.
 * 3. Cold-start stagger — three simultaneously enqueued priority-3 calls are
 *    each separated by at least 2 000 ms.
 * 4. Window reset — after 60 seconds, `requestsThisMinute` is reset to zero.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RateLimiter } from "../../src/finnhub/rate-limiter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Returns a simple async factory function that resolves with `"ok"`.
 *
 * Used as a zero-cost stand-in for a real Finnhub API call in tests that only
 * care about scheduling behaviour, not the return value.
 *
 * @returns An async function that resolves `"ok"` immediately.
 */
const noop = (): Promise<string> => Promise.resolve("ok");

// ---------------------------------------------------------------------------
// describe: RateLimiter
// ---------------------------------------------------------------------------

describe("RateLimiter", () => {
  /**
   * Restore real timers after every test so that fake-timer state cannot leak
   * across test boundaries when a test throws unexpectedly.
   */
  afterEach(() => {
    vi.useRealTimers();
  });

  // -------------------------------------------------------------------------
  // Test 1: Hard ceiling
  // -------------------------------------------------------------------------

  describe("hard ceiling (55 req / 60 s)", () => {
    /**
     * Verifies that the 56th request enqueued within the same 60-second window
     * is NOT dispatched immediately (i.e. it is deferred), and that it IS
     * dispatched once the window rolls over.
     *
     * Approach:
     *  - Enqueue 55 priority-1 items — each is dispatched immediately via the
     *    fast path, filling `requestsThisMinute` to the ceiling.
     *  - Enqueue a 56th priority-1 item — ceiling is now hit, so it enters the
     *    queue and a drain timer is scheduled for the window reset (~60 s).
     *  - Flush microtasks (`advanceTimersByTimeAsync(0)`) to ensure `.finally()`
     *    handlers on the first 55 items have run.
     *  - Assert the 56th has not settled yet.
     *  - Advance fake time by 60 001 ms — the drain timer fires, the window
     *    resets, and the 56th item is dispatched.
     *  - Assert the 56th has now settled.
     */
    it("defers the 56th request until the 60-second window resets", async () => {
      vi.useFakeTimers();
      const limiter = new RateLimiter();

      // Fill the ceiling synchronously using priority-1's fast path.
      for (let i = 0; i < 55; i++) {
        limiter.enqueue(noop, 1);
      }

      expect(limiter.requestsThisMinute).toBe(55);

      // 56th item — ceiling hit, goes to queue.
      let settled = false;
      const p56 = limiter.enqueue(noop, 1).then(() => {
        settled = true;
      });

      // Flush microtasks so that the .finally() handlers of the first 55
      // dispatches (which call scheduleDrain) have had a chance to run.
      await vi.advanceTimersByTimeAsync(0);

      // The 56th should still be pending — drain fires only after 60 s.
      expect(settled).toBe(false);

      // Advance past the 60-second window boundary.
      await vi.advanceTimersByTimeAsync(60_001);

      // Drain fires → window resets → 56th dispatched → promise resolves.
      await p56;
      expect(settled).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Test 2: Priority ordering
  // -------------------------------------------------------------------------

  describe("priority ordering", () => {
    /**
     * Verifies that when a priority-4 item and a priority-1 item are both
     * queued while the ceiling is active, the priority-1 item's factory
     * function is invoked before the priority-4 item's factory function after
     * the window resets.
     *
     * The queue is sorted ascending by priority number (lower = more urgent),
     * so priority-1 sits at the head and is dispatched first inside the single
     * drain call that runs after the window rolls over.
     *
     * Factory function invocations are synchronous inside `dispatchItem`, so
     * the push-order of the `order` array reflects true dispatch order even
     * before the returned Promises settle.
     */
    it("dispatches priority-1 before priority-4 after window reset", async () => {
      vi.useFakeTimers();
      const limiter = new RateLimiter();

      // Fill to ceiling using priority-1 fast path.
      for (let i = 0; i < 55; i++) {
        limiter.enqueue(noop, 1);
      }

      expect(limiter.requestsThisMinute).toBe(55);

      const order: string[] = [];

      // Enqueue lower-priority item first…
      const pLow = limiter.enqueue(() => {
        order.push("p4");
        return Promise.resolve("low");
      }, 4);

      // …then higher-priority item.
      const pHigh = limiter.enqueue(() => {
        order.push("p1");
        return Promise.resolve("high");
      }, 1);

      // Flush microtasks so scheduleDrain from the 55 .finally() handlers runs.
      await vi.advanceTimersByTimeAsync(0);

      // Neither should have been dispatched yet.
      expect(order).toHaveLength(0);

      // Advance past the window boundary — drain fires, queue drains.
      await vi.advanceTimersByTimeAsync(60_001);
      await Promise.all([pLow, pHigh]);

      // priority-1 factory must have been called before priority-4.
      expect(order).toEqual(["p1", "p4"]);
    });
  });

  // -------------------------------------------------------------------------
  // Test 3: Cold-start stagger
  // -------------------------------------------------------------------------

  describe("cold-start stagger (priority 3–4)", () => {
    /**
     * Verifies that three priority-3 items enqueued simultaneously are each
     * dispatched at least 2 000 ms apart.
     *
     * The stagger constraint (`STAGGER_MS = 2 000`) applies to any item whose
     * `priority >= LOW_PRIORITY_MIN (3)`.  Consecutive dispatches of such items
     * must be separated by at least 2 s.
     *
     * Approach:
     *  - Enqueue 3 priority-3 items before the ceiling is reached.
     *  - Record `Date.now()` inside each factory function (synchronous, so it
     *    captures the exact fake-time of dispatch).
     *  - Advance fake time by 10 seconds — enough for all three drains to fire
     *    (drain 1 at ~0 ms, drain 2 at ~2 000 ms, drain 3 at ~4 000 ms).
     *  - Assert consecutive dispatch timestamps differ by ≥ 2 000 ms.
     */
    it("separates consecutive priority-3 dispatches by at least 2 000 ms", async () => {
      vi.useFakeTimers();
      const limiter = new RateLimiter();

      const dispatchTimes: number[] = [];

      /**
       * Creates a factory function that records the fake-clock timestamp at
       * the moment it is invoked, then resolves immediately.
       *
       * @returns An async factory suitable for {@link RateLimiter.enqueue}.
       */
      const makeFn = (): (() => Promise<string>) =>
        () => {
          dispatchTimes.push(Date.now());
          return Promise.resolve("ok");
        };

      const p1 = limiter.enqueue(makeFn(), 3);
      const p2 = limiter.enqueue(makeFn(), 3);
      const p3 = limiter.enqueue(makeFn(), 3);

      // 10 s is enough for: drain@0ms, drain@2000ms, drain@4000ms.
      await vi.advanceTimersByTimeAsync(10_000);
      await Promise.all([p1, p2, p3]);

      expect(dispatchTimes).toHaveLength(3);
      expect(dispatchTimes[1]! - dispatchTimes[0]!).toBeGreaterThanOrEqual(2_000);
      expect(dispatchTimes[2]! - dispatchTimes[1]!).toBeGreaterThanOrEqual(2_000);
    });
  });

  // -------------------------------------------------------------------------
  // Test 4: Window reset
  // -------------------------------------------------------------------------

  describe("window reset", () => {
    /**
     * Verifies that `requestsThisMinute` is reset to zero once 60 seconds
     * have elapsed since the current window started.
     *
     * After filling the ceiling to 55, the drain is scheduled for the window
     * boundary.  When fake time advances past 60 s, the drain fires and calls
     * `refreshWindow()`, which zeroes the counter.  The queue is empty at that
     * point so no new requests are dispatched — the counter stays at 0.
     */
    it("resets requestsThisMinute to 0 after 60 seconds", async () => {
      vi.useFakeTimers();
      const limiter = new RateLimiter();

      // Fill to ceiling.
      for (let i = 0; i < 55; i++) {
        limiter.enqueue(noop, 1);
      }

      expect(limiter.requestsThisMinute).toBe(55);

      // Flush microtasks so .finally() handlers schedule the drain timer.
      await vi.advanceTimersByTimeAsync(0);

      // Advance past the 60-second window boundary.
      await vi.advanceTimersByTimeAsync(60_001);

      // refreshWindow() inside drain() should have zeroed the counter.
      expect(limiter.requestsThisMinute).toBe(0);
    });
  });
});
