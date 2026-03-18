/**
 * @file src/finnhub/rate-limiter.ts
 * @description Priority-aware rate limiter that enforces Finnhub's free-tier
 * hard ceiling of 55 requests per 60-second window.
 *
 * ## Priority tiers
 * | Priority | Use-case                          | Behaviour                         |
 * |----------|-----------------------------------|-----------------------------------|
 * | 1        | User-triggered capability calls   | Dispatched immediately if capacity available; otherwise head-of-queue |
 * | 2        | Watchlist quote sync              | Queued; drained before tier 3–4   |
 * | 3        | Basic metrics / company profiles  | Staggered ≥2 s apart during drain |
 * | 4        | News & earnings (background)      | Staggered ≥2 s apart during drain |
 *
 * ## Design
 * - A **fixed 60-second window** counter (`requestsThisMinute` / `windowStart`)
 *   tracks dispatched requests.  The counter resets when
 *   `Date.now() - windowStart ≥ 60 000`.
 * - A **sorted pending queue** holds un-dispatched items ordered by priority
 *   (ascending — lower number = higher urgency).
 * - A **single drain timer** runs the drain loop after every request settles or
 *   when new items are enqueued, computing the earliest safe next-dispatch time.
 * - **Staggering** for tiers 3–4: consecutive low-priority dispatches must be at
 *   least `STAGGER_MS` (2 000 ms) apart.  High-priority items (tiers 1–2) are
 *   never subject to staggering.
 *
 * @module stocks-interface/finnhub/rate-limiter
 */
/**
 * Priority-aware rate limiter for Finnhub API calls.
 *
 * Enforces a **hard ceiling of 55 requests per 60-second window**.  Requests
 * that arrive when the ceiling is reached are queued and drained in priority
 * order as capacity becomes available.
 *
 * Tier 3–4 (metrics / profiles / news / earnings) dispatches are additionally
 * staggered by a minimum of 2 seconds between consecutive items to smooth
 * cold-start bursts.
 *
 * @example
 * ```ts
 * const limiter = createRateLimiter();
 * const quote = await limiter.enqueue(() => fetchQuote("AAPL"), 2);
 * ```
 */
export declare class RateLimiter {
    /**
     * Number of requests dispatched in the current 60-second window.
     * Reset to zero when `Date.now() - windowStart ≥ WINDOW_MS`.
     */
    requestsThisMinute: number;
    /**
     * Unix millisecond timestamp when the current counting window started.
     * Updated each time the window rolls over inside {@link refreshWindow}.
     */
    windowStart: number;
    /** Sorted pending queue; lowest priority-number is at the front. */
    private readonly queue;
    /**
     * Unix millisecond timestamp of the most recent dispatch of a tier 3–4 item.
     * Initialised to `0` (Unix epoch) so the very first low-priority dispatch is
     * never artificially delayed.
     */
    private lastLowPriorityDispatch;
    /**
     * Handle for the scheduled drain timer, or `null` when no drain is pending.
     * Guards against duplicate timers being created.
     */
    private drainTimer;
    /** Hard ceiling on requests per window (55 of Finnhub's 60 req/min quota). */
    private static readonly CEILING;
    /** Length of the counting window in milliseconds (60 seconds). */
    private static readonly WINDOW_MS;
    /**
     * Priority number at which cold-start staggering begins (inclusive).
     * Items with `priority >= LOW_PRIORITY_MIN` are subject to {@link STAGGER_MS}.
     */
    private static readonly LOW_PRIORITY_MIN;
    /** Minimum gap in milliseconds between consecutive low-priority dispatches. */
    private static readonly STAGGER_MS;
    /**
     * Constructs a new {@link RateLimiter} with a clean window and empty queue.
     *
     * Prefer the {@link createRateLimiter} factory over calling this constructor
     * directly, so that each logical context receives its own isolated instance.
     */
    constructor();
    /**
     * Enqueues an async operation to be executed within the rate limit.
     *
     * The returned Promise resolves or rejects with the same value / reason as
     * the Promise returned by `fn`.
     *
     * **Priority semantics:**
     * - `priority === 1` — dispatched immediately if capacity permits; otherwise
     *   placed at the front of the queue ahead of all other tiers.
     * - `priority === 2` — queued in priority order; no stagger constraint.
     * - `priority === 3 | 4` — queued in priority order; consecutive dispatches
     *   are spaced at least 2 seconds apart.
     *
     * @param fn       Zero-argument async factory function to execute.
     * @param priority Numeric priority tier in the range 1–4 (lower = higher urgency).
     * @returns        A Promise that settles with the return value of `fn`.
     */
    enqueue<T>(fn: () => Promise<T>, priority: number): Promise<T>;
    /**
     * Rolls over the counting window if 60 seconds have elapsed since
     * `windowStart`, resetting `requestsThisMinute` to zero.
     *
     * Must be called before any capacity check to ensure the counter reflects the
     * current window.
     */
    private refreshWindow;
    /**
     * Sorts {@link queue} in ascending priority-number order so that
     * `queue[0]` is always the highest-urgency pending item.
     *
     * Called after every push to maintain the invariant relied on by
     * {@link findNextDispatchable}.
     */
    private sortQueue;
    /**
     * Finds the index of the first queue item that can be dispatched right now.
     *
     * An item is dispatchable if:
     * - It is a high-priority item (tier 1–2), **or**
     * - It is a low-priority item (tier 3–4) **and** at least {@link STAGGER_MS}
     *   milliseconds have elapsed since the last low-priority dispatch.
     *
     * Because the queue is sorted by priority, once a low-priority item is
     * encountered with the stagger constraint still active, all subsequent items
     * will also be low-priority — so iteration stops early with a `break`.
     *
     * @returns Index of the first dispatchable item, or `-1` if none is ready.
     */
    private findNextDispatchable;
    /**
     * Immediately dispatches a single queue item.
     *
     * Increments `requestsThisMinute` synchronously (before the async call
     * begins), records the dispatch timestamp for low-priority stagger tracking,
     * and schedules a drain when the item's Promise settles.
     *
     * @param item The queue item to execute.
     */
    private dispatchItem;
    /**
     * Drains the queue, dispatching items until the ceiling is reached or no
     * immediately dispatchable item remains.
     *
     * Called by the drain timer on each scheduled tick.  After draining,
     * re-schedules itself if items remain in the queue.
     */
    private drain;
    /**
     * Schedules the {@link drain} loop to run after the computed delay.
     *
     * **Delay computation (all constraints are max-combined):**
     * 1. The caller-supplied `delayMs` floor.
     * 2. Window-reset wait — when `requestsThisMinute >= CEILING`, waits until
     *    the current 60-second window expires.
     * 3. Low-priority stagger wait — when the queue contains only tier 3–4 items
     *    and the stagger gap has not yet elapsed, waits for the gap to clear.
     *
     * No-ops if a drain is already scheduled (`drainTimer !== null`), preventing
     * duplicate timers from accumulating when many requests complete simultaneously.
     *
     * @param delayMs Optional minimum delay in milliseconds before draining.
     *                Defaults to `0` (drain as soon as other constraints allow).
     */
    private scheduleDrain;
}
/**
 * Creates and returns a new {@link RateLimiter} instance with a clean window
 * and empty queue.
 *
 * Prefer this factory over `new RateLimiter()` directly — it makes dependency
 * injection and unit-test isolation simpler (each call produces an independent
 * limiter with its own state).
 *
 * @returns A freshly initialised {@link RateLimiter}.
 *
 * @example
 * ```ts
 * // Application startup
 * export const limiter = createRateLimiter();
 *
 * // Usage
 * const profile = await limiter.enqueue(() => client.companyProfile("AAPL"), 3);
 * ```
 */
export declare function createRateLimiter(): RateLimiter;
//# sourceMappingURL=rate-limiter.d.ts.map