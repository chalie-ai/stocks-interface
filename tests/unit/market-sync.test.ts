/**
 * @file tests/unit/market-sync.test.ts
 * @description Unit tests for {@link MarketSync} from src/sync/market-sync.ts.
 *
 * All tests are pure — no network calls, no file I/O.  {@link FakeTime} is
 * used throughout so that `setTimeout` and `Date.now()` are fully controlled.
 *
 * ## Coverage
 *
 * ### Threshold evaluation (stock signals)
 * 1. No signal when `|changePercent|` is below `notableThresholdStock`.
 * 2. `stock_move` emitted when change is between threshold and threshold×2.5.
 * 3. `stock_alert` emitted when change exceeds threshold×2.5.
 * 4. `stock_alert` energy is exactly `0.65`.
 *
 * ### Deduplication
 * 5. Same `symbol:type:bracket` key within the 2-hour window emits only once.
 * 6. Same key fires again after the 2-hour window expires.
 *
 * ### Market close summary
 * 7. `onSummary` is called exactly once when the market transitions from open
 *    to a non-open state after 16:00 ET and no summary has been emitted today.
 * 8. `onSummary` is NOT called when `lastMarketSummaryDate` already equals
 *    today's ET date string (idempotency guard).
 *
 * ### Threshold settings
 * 9. Raising `notableThresholdStock` above the current `|changePercent|`
 *    transitions from `stock_move` to no signal.
 *
 * @module stocks-interface/tests/unit/market-sync
 */

import { afterEach, beforeEach, describe, it } from "jsr:@std/testing/bdd";
import { expect, fn } from "jsr:@std/expect";
import { FakeTime } from "jsr:@std/testing/time";
import { spy } from "jsr:@std/testing/mock";
import type { Spy } from "jsr:@std/testing/mock";
import { MarketSync } from "../../src/sync/market-sync.ts";
import type { Signal } from "../../src/sync/market-sync.ts";
import type {
  MarketStatus,
  Quote,
  Settings,
  ToolState,
  WatchlistItem,
} from "../../src/finnhub/types.ts";
import type {
  FinnhubClient,
  MetricsCacheEntry,
} from "../../src/finnhub/client.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * A UTC timestamp that falls at 16:30 Eastern Daylight Time on 2026-03-18.
 * EDT = UTC−4; 2026-03-18 is after the DST switch (March 8, 2026), so the
 * New York wall-clock reads 16:30 at this moment.
 *
 * Used for market-close summary tests that require ET time ≥ 16:00.
 */
const AFTER_CLOSE_UTC = new Date("2026-03-18T20:30:00.000Z").getTime();

/**
 * A UTC timestamp that falls at 12:00 Eastern Daylight Time on 2026-03-18.
 * Used as a "midday" baseline for deduplication and threshold tests where
 * market-close logic must not interfere.
 */
const MIDDAY_UTC = new Date("2026-03-18T16:00:00.000Z").getTime();

// ---------------------------------------------------------------------------
// Default settings fixture
// ---------------------------------------------------------------------------

/**
 * Minimal {@link Settings} fixture applied to every test state.
 *
 * Key values for threshold tests:
 *  - `notableThresholdStock = 2`  → `stock_move` triggers at ≥ 2%,
 *                                     `stock_alert` triggers at > 5% (2 × 2.5).
 *  - `notableThresholdIndex = 1`  → `market_move` at ≥ 1%, `market_alert` > 1.5%.
 */
const DEFAULT_SETTINGS: Settings = {
  syncIntervalMarketOpen: 60_000,
  syncIntervalMarketClosed: 300_000,
  notableThresholdStock: 2,
  notableThresholdIndex: 1,
  maxWatchlistSize: 30,
};

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * Builds a minimal {@link ToolState} ready for use in tests.
 *
 * The `lastKnownMarketState` defaults to `"open"` (not `null`) so that the
 * "daemon start" code path in the market-close summary logic is NOT exercised
 * unless the caller explicitly overrides it to `null`.
 *
 * @param overrides - Partial state fields that replace the defaults.
 * @returns A {@link ToolState} fixture.
 */
function makeState(overrides: Partial<ToolState> = {}): ToolState {
  return {
    apiKey: "test-key",
    watchlist: [],
    priceAlerts: [],
    lastSyncAt: null,
    lastMarketSummaryDate: null,
    lastKnownMarketState: "open",
    dedupHistory: [],
    settings: { ...DEFAULT_SETTINGS },
    ...overrides,
  };
}

/**
 * Builds a {@link WatchlistItem} fixture.
 *
 * @param symbol  - Ticker symbol (e.g. `"AAPL"`).
 * @param isIndex - When `true`, the item uses the index threshold table.
 *                  Defaults to `false`.
 * @returns A {@link WatchlistItem} fixture.
 */
function makeWatchlistItem(symbol: string, isIndex = false): WatchlistItem {
  return {
    symbol,
    name: `${symbol} Corp`,
    exchange: "US",
    type: isIndex ? "etf" : "stock",
    addedAt: "2026-01-01T00:00:00.000Z",
    isIndex,
  };
}

/**
 * Builds a {@link Quote} fixture for a given symbol, percentage change, and
 * optional price.
 *
 * Volume defaults to `1 000 000`, which stays below the 3× unusual-volume
 * threshold when `averageVolume10Day = 500 000`.  Set to a higher value in
 * tests that exercise the volume-alert path.
 *
 * @param symbol        - Ticker symbol.
 * @param changePercent - Intraday percentage change (positive = up, negative = down).
 * @param price         - Current price; defaults to `100`.
 * @returns A fully-populated {@link Quote} fixture.
 */
function makeQuote(symbol: string, changePercent: number, price = 100): Quote {
  return {
    symbol,
    name: null,
    price,
    change: parseFloat((price * changePercent / 100).toFixed(4)),
    changePercent,
    high: price * 1.01,
    low: price * 0.99,
    open: price * 0.995,
    previousClose: price / (1 + changePercent / 100),
    timestamp: Math.floor(Date.now() / 1_000),
    volume: 1_000_000,
  };
}

/**
 * A minimal mock of {@link FinnhubClient} that satisfies the interface
 * consumed by {@link MarketSync}.
 *
 * Uses {@link Spy} so individual tests can inspect call counts.
 */
type MockClient = {
  metricsCache: Map<string, MetricsCacheEntry>;
  quote: Spy<unknown, unknown[], unknown>;
  marketStatus: Spy<unknown, unknown[], unknown>;
};

/**
 * Builds a {@link MockClient} that returns the supplied quote on every
 * `quote()` call and the given market-open flag on every `marketStatus()` call.
 *
 * The `metricsCache` is intentionally empty so that 52-week and volume
 * conditions are skipped in tests that don't require them.
 *
 * @param quoteResult  - The {@link Quote} value resolved by `client.quote()`.
 * @param marketIsOpen - Value for `MarketStatus.isOpen`; defaults to `true`.
 * @returns A {@link MockClient} fixture.
 */
function makeMockClient(quoteResult: Quote, marketIsOpen = true): MockClient {
  return {
    metricsCache: new Map(),
    quote: spy(() => Promise.resolve(quoteResult)),
    marketStatus: spy(() =>
      Promise.resolve({
        exchange: "US",
        isOpen: marketIsOpen,
        holiday: null,
      } as MarketStatus)
    ),
  };
}

// ---------------------------------------------------------------------------
// Cycle runner helpers
// ---------------------------------------------------------------------------

/**
 * Starts a {@link MarketSync} cycle and awaits its completion via the
 * `onCycleDone` hook, then calls `stop()` and returns the collected signals.
 *
 * Using `onCycleDone` rather than a fixed `tick(N)` delay ensures the test
 * waits for the entire async chain inside `runCycle` to complete — including
 * the `await client.marketStatus()` and `await Promise.allSettled(quotes)` hops
 * — before inspecting emitted signals.
 *
 * Requires a {@link FakeTime} instance to already be active when called.
 *
 * @param state     - Tool state passed to `startSync`.
 * @param client    - Mock Finnhub client passed to `startSync`.
 * @param time      - The active {@link FakeTime} instance used to tick timers.
 * @param onSummary - Optional summary callback; defaults to a no-op spy.
 * @returns An array of all {@link Signal} objects emitted during the cycle.
 */
async function runOneCycle(
  state: ToolState,
  client: MockClient,
  time: FakeTime,
  onSummary: (quotes: Quote[]) => void = () => {},
): Promise<Signal[]> {
  const signals: Signal[] = [];
  const sync = new MarketSync();

  // `cycleDone` resolves when `runCycle` calls the `onCycleDone` hook, which
  // happens after signals have been emitted and the cycle's async work is done.
  let cycleResolve!: () => void;
  const cycleDone = new Promise<void>((res) => {
    cycleResolve = res;
  });

  const stop = sync.startSync(
    state,
    client as unknown as FinnhubClient,
    (s) => signals.push(s),
    onSummary,
    async () => {
      cycleResolve();
    },
  );

  // Fire the initial `setTimeout(fn, 0)` that kicks off the first cycle.
  await time.tick(1);
  // Wait for `runCycle`'s async chain (marketStatus + allSettled) to complete
  // and for `onCycleDone` to be called. The event loop processes microtasks
  // freely while we await this promise.
  await cycleDone;

  stop();
  return signals;
}

/**
 * Starts a {@link MarketSync} cycle for the given `sync` instance, writes
 * emitted signals into `signals`, and waits for cycle completion via the
 * `onCycleDone` hook.  Returns the `stop` function without calling it, so the
 * caller can cancel the next-cycle timer explicitly.
 *
 * Used by deduplication tests that need to run multiple sequential cycles
 * against the same `sync` instance while sharing a signal accumulator.
 *
 * @param sync     - {@link MarketSync} instance to run.
 * @param state    - Mutable tool state shared across cycles.
 * @param client   - Mock Finnhub client.
 * @param signals  - Shared array to push emitted signals into.
 * @param time     - The active {@link FakeTime} instance.
 * @returns        The stop function (not yet called).
 */
async function startAndAwaitCycle(
  sync: MarketSync,
  state: ToolState,
  client: MockClient,
  signals: Signal[],
  time: FakeTime,
): Promise<() => void> {
  let cycleResolve!: () => void;
  const cycleDone = new Promise<void>((res) => {
    cycleResolve = res;
  });

  const stop = sync.startSync(
    state,
    client as unknown as FinnhubClient,
    (s: Signal) => signals.push(s),
    spy() as unknown as (quotes: Quote[]) => void,
    async () => {
      cycleResolve();
    },
  );

  await time.tick(1);
  await cycleDone;
  return stop;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("MarketSync", () => {
  /** Fake-timer instance shared across all tests in this suite. */
  let time: FakeTime;

  /**
   * Install fake timers before every test so that `setTimeout` and `Date.now`
   * are fully controlled, initialising the clock at midday ET so that
   * market-close summary logic will not trigger unexpectedly.
   */
  beforeEach(() => {
    time = new FakeTime(MIDDAY_UTC);
  });

  /**
   * Restore real timers after every test to prevent state leaking across
   * test boundaries.
   */
  afterEach(() => {
    time.restore();
  });

  // -------------------------------------------------------------------------
  // 1. No signal below threshold
  // -------------------------------------------------------------------------

  describe("threshold evaluation — no signal", () => {
    /**
     * When the absolute intraday change is below `notableThresholdStock`, no
     * stock signal should be emitted.
     *
     * Fixture: threshold = 2 %, change = 1.5 % → below the 2 % floor.
     */
    it("does not emit a signal when |changePercent| is below notableThresholdStock", async () => {
      const item = makeWatchlistItem("AAPL");
      // change = 1.5 %, threshold = 2 %  → 1.5 < 2, no signal
      const state = makeState({ watchlist: [item] });
      const client = makeMockClient(makeQuote("AAPL", 1.5));

      const signals = await runOneCycle(state, client, time);

      const stockSignals = signals.filter(
        (s) =>
          s.symbol === "AAPL" &&
          (s.type === "stock_move" || s.type === "stock_alert"),
      );
      expect(stockSignals).toHaveLength(0);
    });

    /**
     * A negative change below the threshold magnitude should also produce no
     * signal (the evaluation uses `|changePercent|`).
     *
     * Fixture: threshold = 2 %, change = −1.0 %.
     */
    it("does not emit a signal for a small negative change below the threshold", async () => {
      const item = makeWatchlistItem("TSLA");
      const state = makeState({ watchlist: [item] });
      const client = makeMockClient(makeQuote("TSLA", -1.0));

      const signals = await runOneCycle(state, client, time);

      const stockSignals = signals.filter(
        (s) =>
          s.symbol === "TSLA" &&
          (s.type === "stock_move" || s.type === "stock_alert"),
      );
      expect(stockSignals).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 2. stock_move: threshold ≤ change < threshold × 2.5
  // -------------------------------------------------------------------------

  describe("threshold evaluation — stock_move", () => {
    /**
     * A change at or above `notableThresholdStock` but strictly below
     * `notableThresholdStock × 2.5` should emit a single `stock_move` signal.
     *
     * Fixture: threshold = 2 %, change = 3 % → 2 ≤ 3 < 5 → `stock_move`.
     */
    it("emits stock_move when |changePercent| is between threshold and threshold×2.5", async () => {
      const item = makeWatchlistItem("AAPL");
      // change = 3 %, threshold = 2 %, threshold×2.5 = 5 %  → stock_move
      const state = makeState({ watchlist: [item] });
      const client = makeMockClient(makeQuote("AAPL", 3));

      const signals = await runOneCycle(state, client, time);

      const moves = signals.filter((s) => s.type === "stock_move");
      expect(moves).toHaveLength(1);
      expect(moves[0]!.symbol).toBe("AAPL");
      expect(moves[0]!.topic).toBe("stocks");
    });

    /**
     * A negative change whose magnitude falls in the `stock_move` band should
     * produce a `stock_move` signal, not a `stock_alert`.
     *
     * Fixture: threshold = 2 %, change = −4.5 % → 2 ≤ 4.5 < 5 → `stock_move`.
     */
    it("emits stock_move for a negative change in the mid-tier band", async () => {
      const item = makeWatchlistItem("MSFT");
      const state = makeState({ watchlist: [item] });
      const client = makeMockClient(makeQuote("MSFT", -4.5));

      const signals = await runOneCycle(state, client, time);

      const moves = signals.filter((s) =>
        s.type === "stock_move" && s.symbol === "MSFT"
      );
      expect(moves).toHaveLength(1);
      // Exactly at the boundary: no stock_alert should co-fire
      const alerts = signals.filter((s) =>
        s.type === "stock_alert" && s.symbol === "MSFT"
      );
      expect(alerts).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 3. stock_alert: change > threshold × 2.5
  // -------------------------------------------------------------------------

  describe("threshold evaluation — stock_alert", () => {
    /**
     * A change exceeding `notableThresholdStock × 2.5` must emit a
     * `stock_alert` signal and must NOT additionally emit a `stock_move`.
     *
     * Fixture: threshold = 2 %, change = 6 % → 6 > 5 → `stock_alert` only.
     */
    it("emits stock_alert when |changePercent| exceeds threshold×2.5", async () => {
      const item = makeWatchlistItem("AAPL");
      // change = 6 %, threshold = 2 %, threshold×2.5 = 5 %  → stock_alert
      const state = makeState({ watchlist: [item] });
      const client = makeMockClient(makeQuote("AAPL", 6));

      const signals = await runOneCycle(state, client, time);

      const alerts = signals.filter((s) => s.type === "stock_alert");
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.symbol).toBe("AAPL");

      // stock_move must NOT fire alongside stock_alert (exclusive tiers)
      const moves = signals.filter((s) =>
        s.type === "stock_move" && s.symbol === "AAPL"
      );
      expect(moves).toHaveLength(0);
    });

    /**
     * A large negative change should produce a `stock_alert`, not a `stock_move`.
     *
     * Fixture: threshold = 2 %, change = −8 % → 8 > 5 → `stock_alert`.
     */
    it("emits stock_alert for a large negative change", async () => {
      const item = makeWatchlistItem("NVDA");
      const state = makeState({ watchlist: [item] });
      const client = makeMockClient(makeQuote("NVDA", -8));

      const signals = await runOneCycle(state, client, time);

      const alerts = signals.filter((s) =>
        s.type === "stock_alert" && s.symbol === "NVDA"
      );
      expect(alerts).toHaveLength(1);
    });
  });

  // -------------------------------------------------------------------------
  // 4. stock_alert energy = 0.65
  // -------------------------------------------------------------------------

  describe("signal energy", () => {
    /**
     * `stock_alert` must carry exactly `energy = 0.65`, the ceiling value
     * documented in the plan for non-user-sourced signals.
     */
    it("assigns energy 0.65 to stock_alert signals", async () => {
      const item = makeWatchlistItem("AAPL");
      const state = makeState({ watchlist: [item] });
      // Deliberately exceed the 5 % alert threshold
      const client = makeMockClient(makeQuote("AAPL", 7));

      const signals = await runOneCycle(state, client, time);

      const alert = signals.find((s) => s.type === "stock_alert");
      expect(alert).toBeDefined();
      expect(alert!.energy).toBe(0.65);
    });

    /**
     * `stock_move` must carry `energy = 0.40`.
     */
    it("assigns energy 0.40 to stock_move signals", async () => {
      const item = makeWatchlistItem("MSFT");
      const state = makeState({ watchlist: [item] });
      const client = makeMockClient(makeQuote("MSFT", 3));

      const signals = await runOneCycle(state, client, time);

      const move = signals.find((s) => s.type === "stock_move");
      expect(move).toBeDefined();
      expect(move!.energy).toBe(0.4);
    });
  });

  // -------------------------------------------------------------------------
  // 5. Deduplication — same key within 2 hours emits only once
  // -------------------------------------------------------------------------

  describe("deduplication — within 2-hour window", () => {
    /**
     * After a `stock_alert` fires at time T, a second sync cycle at T + 1 hour
     * (within the 2-hour suppression window) must NOT emit the same signal again.
     *
     * Approach:
     *  1. Run cycle 1 at MIDDAY_UTC → signal fires, key recorded in dedupHistory.
     *  2. Cancel cycle 1's next-timer, then advance fake clock by 1 hour.
     *  3. Run cycle 2 → signal suppressed because key is not yet expired.
     */
    it("suppresses the same stock_alert key within the 2-hour dedup window", async () => {
      const item = makeWatchlistItem("AAPL");
      const state = makeState({ watchlist: [item] });
      const client = makeMockClient(makeQuote("AAPL", 6));

      const signals: Signal[] = [];
      const sync = new MarketSync();

      // ── Cycle 1 at T ───────────────────────────────────────────────────────
      const stop1 = await startAndAwaitCycle(
        sync,
        state,
        client,
        signals,
        time,
      );
      // Cancel the next-cycle timer before advancing time, so the loop
      // doesn't fire spurious cycles during the 1-hour tick.
      stop1();

      const countAfterCycle1 =
        signals.filter((s) => s.type === "stock_alert").length;
      expect(countAfterCycle1).toBe(1);

      // ── Advance 1 hour — within dedup window ───────────────────────────────
      await time.tick(60 * 60 * 1_000);

      // ── Cycle 2 at T + 1 h ─────────────────────────────────────────────────
      const stop2 = await startAndAwaitCycle(
        sync,
        state,
        client,
        signals,
        time,
      );
      stop2();

      // Still only one stock_alert — the second cycle was suppressed.
      const countAfterCycle2 =
        signals.filter((s) => s.type === "stock_alert").length;
      expect(countAfterCycle2).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Deduplication — same key after 2 hours fires again
  // -------------------------------------------------------------------------

  describe("deduplication — after 2-hour window expires", () => {
    /**
     * After the 2-hour suppression window has elapsed, the same signal key
     * must be allowed to fire again.
     *
     * Approach:
     *  1. Run cycle 1 at MIDDAY_UTC → signal fires.
     *  2. Cancel cycle 1's timer, advance fake clock by 3 hours.
     *  3. Run cycle 2 → dedup entry has expired; signal fires again.
     */
    it("allows the same stock_alert key to fire again after the 2-hour window expires", async () => {
      const item = makeWatchlistItem("TSLA");
      const state = makeState({ watchlist: [item] });
      const client = makeMockClient(makeQuote("TSLA", 8));

      const signals: Signal[] = [];
      const sync = new MarketSync();

      // ── Cycle 1 at T ───────────────────────────────────────────────────────
      const stop1 = await startAndAwaitCycle(
        sync,
        state,
        client,
        signals,
        time,
      );
      stop1();

      expect(signals.filter((s) => s.type === "stock_alert")).toHaveLength(1);

      // ── Advance 3 hours — beyond the 2-hour TTL ────────────────────────────
      await time.tick(3 * 60 * 60 * 1_000);

      // ── Cycle 2 at T + 3 h ─────────────────────────────────────────────────
      const stop2 = await startAndAwaitCycle(
        sync,
        state,
        client,
        signals,
        time,
      );
      stop2();

      // The dedup entry from cycle 1 has expired; signal fires a second time.
      expect(signals.filter((s) => s.type === "stock_alert")).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // 7. Market close summary — called on open→closed transition after 16:00 ET
  // -------------------------------------------------------------------------

  describe("market close summary — transition to closed", () => {
    /**
     * `onSummary` must be called exactly once when all of the following hold:
     *  - Current ET time is ≥ 16:00 (market has closed for the day).
     *  - `state.lastMarketSummaryDate` is not today's ET date string.
     *  - The market state transitions from `"open"` to a non-open state.
     *
     * Fixture: fake clock is advanced to 16:30 EDT (20:30 UTC) on 2026-03-18.
     * `state.lastKnownMarketState = "open"`, `marketStatus` returns
     * `isOpen: false`.
     */
    it("calls onSummary once when market transitions from open to closed after 16:00 ET", async () => {
      // Advance from MIDDAY_UTC (12:00 EDT) to AFTER_CLOSE_UTC (16:30 EDT).
      await time.tick(AFTER_CLOSE_UTC - MIDDAY_UTC);

      const item = makeWatchlistItem("AAPL");
      const state = makeState({
        watchlist: [item],
        lastKnownMarketState: "open", // was open before this cycle
        lastMarketSummaryDate: null, // no summary yet today
      });
      // Quote with a small change — we don't want threshold signals to
      // interfere with the summary assertion.
      const client = makeMockClient(makeQuote("AAPL", 0.5), false);

      // `fn()` from @std/expect creates a mock that sets Symbol.for("@MOCK"),
      // making it compatible with `toHaveBeenCalledTimes` and `not.toHaveBeenCalled`.
      // A closure captures the first argument for the post-call assertion.
      let capturedSummaryArg: unknown;
      const onSummary = fn((quotes: Quote[]) => {
        capturedSummaryArg = quotes;
      }) as (quotes: Quote[]) => void;

      await runOneCycle(state, client, time, onSummary);

      expect(onSummary).toHaveBeenCalledTimes(1);
      // onSummary receives the array of fetched quotes as its first argument.
      expect(Array.isArray(capturedSummaryArg)).toBe(true);
    });

    /**
     * `onSummary` must be called when `lastKnownMarketState` is `null`
     * (daemon start) and the daemon starts after market close with no summary
     * yet emitted today.
     *
     * This handles the "restart after market close" scenario described in the
     * plan (Issue 9).
     */
    it("calls onSummary on daemon start when market is already closed after 16:00 ET", async () => {
      // Advance from MIDDAY_UTC (12:00 EDT) to AFTER_CLOSE_UTC (16:30 EDT).
      await time.tick(AFTER_CLOSE_UTC - MIDDAY_UTC);

      const item = makeWatchlistItem("SPY");
      const state = makeState({
        watchlist: [item],
        lastKnownMarketState: null, // daemon just started — no prior state
        lastMarketSummaryDate: null,
      });
      const client = makeMockClient(makeQuote("SPY", 0.3), false);

      const onSummary = fn() as (quotes: Quote[]) => void;
      await runOneCycle(state, client, time, onSummary);

      expect(onSummary).toHaveBeenCalledTimes(1);
    });
  });

  // -------------------------------------------------------------------------
  // 8. Market close summary — NOT called when already emitted today
  // -------------------------------------------------------------------------

  describe("market close summary — idempotency guard", () => {
    /**
     * When `state.lastMarketSummaryDate` already equals today's ET date string,
     * `onSummary` must NOT be called even though all other conditions are met.
     *
     * This prevents duplicate summaries within the same trading day even if the
     * daemon restarts multiple times after market close.
     *
     * Fixture: `lastMarketSummaryDate = "2026-03-18"` at 16:30 EDT.
     */
    it("does NOT call onSummary when lastMarketSummaryDate already equals today", async () => {
      // Advance from MIDDAY_UTC (12:00 EDT) to AFTER_CLOSE_UTC (16:30 EDT).
      await time.tick(AFTER_CLOSE_UTC - MIDDAY_UTC);

      const item = makeWatchlistItem("AAPL");
      const state = makeState({
        watchlist: [item],
        lastKnownMarketState: "open",
        lastMarketSummaryDate: "2026-03-18", // already emitted today
      });
      const client = makeMockClient(makeQuote("AAPL", 0.5), false);

      const onSummary = fn() as (quotes: Quote[]) => void;
      await runOneCycle(state, client, time, onSummary);

      expect(onSummary).not.toHaveBeenCalled();
    });

    /**
     * `onSummary` must NOT be called if the clock is before 16:00 ET, even if
     * the market state transitions to non-open (e.g. an unexpected early halt).
     *
     * Fixture: fake clock set to 13:00 EDT (17:00 UTC), market closed.
     */
    it("does NOT call onSummary when ET hour is before 16:00, even on transition", async () => {
      // Advance from MIDDAY_UTC (16:00 UTC = 12:00 EDT) to 17:00 UTC (13:00 EDT).
      await time.tick(
        new Date("2026-03-18T17:00:00.000Z").getTime() - MIDDAY_UTC,
      );

      const item = makeWatchlistItem("AAPL");
      const state = makeState({
        watchlist: [item],
        lastKnownMarketState: "open",
        lastMarketSummaryDate: null,
      });
      const client = makeMockClient(makeQuote("AAPL", 0.5), false);

      const onSummary = fn() as (quotes: Quote[]) => void;
      await runOneCycle(state, client, time, onSummary);

      expect(onSummary).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 9. Threshold settings — changing notableThresholdStock changes signal tier
  // -------------------------------------------------------------------------

  describe("threshold settings — notableThresholdStock controls signal tier", () => {
    /**
     * With `notableThresholdStock = 2` and `|changePercent| = 3`, a
     * `stock_move` signal is emitted.  Raising the threshold to `3.5` makes
     * the same change fall below the floor, so no signal is emitted.
     *
     * This verifies that the threshold tables reference `state.settings` rather
     * than hard-coded values.
     */
    it("stops emitting stock_move when notableThresholdStock is raised above the change", async () => {
      const item = makeWatchlistItem("AAPL");
      const client = makeMockClient(makeQuote("AAPL", 3));

      // ── Baseline: threshold = 2 %, change = 3 % → stock_move ───────────────
      const stateLow = makeState({
        watchlist: [item],
        settings: { ...DEFAULT_SETTINGS, notableThresholdStock: 2 },
      });
      const signals1 = await runOneCycle(stateLow, client, time);
      expect(signals1.filter((s) => s.type === "stock_move")).toHaveLength(1);

      // ── Raised threshold: threshold = 3.5 %, change = 3 % → no signal ──────
      const stateHigh = makeState({
        watchlist: [item],
        settings: { ...DEFAULT_SETTINGS, notableThresholdStock: 3.5 },
      });
      const signals2 = await runOneCycle(stateHigh, client, time);
      const stockSignals2 = signals2.filter(
        (s) =>
          s.symbol === "AAPL" &&
          (s.type === "stock_move" || s.type === "stock_alert"),
      );
      expect(stockSignals2).toHaveLength(0);
    });

    /**
     * Lowering `notableThresholdStock` to `1` with the same `|changePercent| = 3`
     * causes the change to exceed `threshold × 2.5 = 2.5`, so the emitted
     * signal escalates from `stock_move` to `stock_alert`.
     *
     * This verifies that both tiers (move and alert) are dynamically governed
     * by the settings value.
     */
    it("escalates to stock_alert when notableThresholdStock is lowered so change exceeds threshold×2.5", async () => {
      const item = makeWatchlistItem("MSFT");
      // change = 3 %, new threshold = 1 %, threshold×2.5 = 2.5 % → stock_alert
      const state = makeState({
        watchlist: [item],
        settings: { ...DEFAULT_SETTINGS, notableThresholdStock: 1 },
      });
      const client = makeMockClient(makeQuote("MSFT", 3));

      const signals = await runOneCycle(state, client, time);

      const alerts = signals.filter((s) =>
        s.type === "stock_alert" && s.symbol === "MSFT"
      );
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.energy).toBe(0.65);

      // stock_move must NOT co-fire
      const moves = signals.filter((s) =>
        s.type === "stock_move" && s.symbol === "MSFT"
      );
      expect(moves).toHaveLength(0);
    });
  });
});
