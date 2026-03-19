/**
 * @file src/sync/market-sync.ts
 * @description Background polling and signal-emission engine for the stocks-interface tool.
 *
 * The {@link MarketSync} class drives the main sync loop: on a configurable
 * interval it fetches market status and quotes for all watchlisted symbols,
 * evaluates six threshold conditions, and emits typed Chalie {@link Signal}
 * objects via an `onSignal` callback. It also detects the market-close
 * transition and fires a daily end-of-day summary via `onSummary`.
 *
 * ## Signal types and energy values (all ≤ 0.65)
 * | Signal type       | Condition                                    | Energy |
 * |-------------------|----------------------------------------------|--------|
 * | `stock_alert`     | `|changePercent|` > threshold × 2.5          | 0.65   |
 * | `stock_move`      | `|changePercent|` ≥ threshold                | 0.40   |
 * | `stock_milestone` | Price at/above 52-wk high OR at/below 52-wk low | 0.55 |
 * | `stock_volume`    | Intraday volume > 3 × 10-day average         | 0.45   |
 * | `market_alert`    | Index `|changePercent|` > indexThreshold × 1.5 | 0.65 |
 * | `market_move`     | Index `|changePercent|` ≥ indexThreshold     | 0.35   |
 *
 * ## Deduplication
 * Each signal is keyed as `"symbol:signalType:thresholdBracket"` and
 * suppressed for 2 hours after it first fires. Expired entries are pruned
 * from `state.dedupHistory` on every cycle.
 *
 * ## Market close summary
 * Emitted once per trading day when:
 * - The market transitions from `"open"` to a non-open state AND current ET
 *   time is ≥ 16:00, AND today's summary has not been emitted; **or**
 * - The daemon starts in an after-hours / closed state and today's summary
 *   has not been emitted (handles restarts after market close).
 *
 * @module stocks-interface/sync/market-sync
 */

import type { FinnhubClient } from "../finnhub/client.ts";
import type {
  BasicMetrics,
  Quote,
  ToolState,
  WatchlistItem,
} from "../finnhub/types.ts";
import { checkAlerts, formatAlertMessage } from "./alerts.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Duration in milliseconds after which a deduplication history entry expires
 * and the same signal key may fire again.
 */
const DEDUP_TTL_MS = 2 * 60 * 60 * 1_000; // 2 hours

/**
 * IANA timezone identifier for US Eastern Time.
 * Used for market-close detection; handles EST/EDT transitions automatically
 * via `Intl.DateTimeFormat`.
 */
const ET_TIMEZONE = "America/New_York";

/**
 * Hour (in ET, 24-hour clock) at or after which the US regular trading
 * session is considered closed.  NYSE and NASDAQ close at 16:00 ET.
 */
const MARKET_CLOSE_HOUR_ET = 16;

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

/**
 * A typed background signal emitted by the {@link MarketSync} engine.
 *
 * Consumers receive signals via the `onSignal` callback passed to
 * {@link MarketSync.startSync}. The `content` field is a human-readable
 * sentence ready for injection into Chalie's reasoning context.
 *
 * All energy values are ≤ 0.65 to stay below the ceiling for non-user
 * sources in Chalie's internal signal hierarchy.
 */
export interface Signal {
  /**
   * Signal type identifier used by Chalie to route and render the signal.
   *
   * `"market_summary"` is included in this union for type completeness; the
   * daily summary is delivered through the separate `onSummary` callback
   * rather than through `onSignal`.
   */
  type:
    | "stock_alert"
    | "stock_move"
    | "stock_milestone"
    | "stock_volume"
    | "market_alert"
    | "market_move"
    | "market_summary";

  /** Ticker symbol this signal pertains to (e.g. `"AAPL"`, `"SPY"`). */
  symbol: string;

  /**
   * Human-readable name of the company or fund, sourced from the Finnhub
   * profile cache. `null` if the profile has not yet been fetched.
   */
  name: string | null;

  /**
   * Activation energy in the range `[0, 0.65]`. Higher values surface the
   * signal more prominently in Chalie's reasoning.
   */
  energy: number;

  /**
   * Human-readable description of the event, suitable for prompt injection
   * or UI display.
   *
   * @example `"AAPL is up +6.2% today ($185.40), exceeding the +5.0% alert threshold."`
   */
  content: string;

  /**
   * Broad topic that groups related signals in the Chalie UI.
   * Either `"stocks"` (individual equity signals) or `"market"` (index signals).
   */
  topic: string;
}

/**
 * Callback invoked once per qualifying signal per sync cycle.
 *
 * @param signal - The emitted {@link Signal} payload.
 */
export type OnSignalFn = (signal: Signal) => void;

/**
 * Callback invoked once per trading day when market-close conditions are met.
 *
 * Receives the most recent quotes for all watchlisted symbols so callers can
 * generate a rich end-of-day performance summary.
 *
 * @param quotes - Array of the latest {@link Quote} values for every symbol
 *                 in the watchlist that was successfully fetched this cycle.
 */
export type OnSummaryFn = (quotes: Quote[]) => void;

/**
 * Function returned by {@link MarketSync.startSync} that cancels the sync
 * loop.
 *
 * Calling it clears all pending timers and prevents any further cycle from
 * being scheduled.  Safe to call more than once (idempotent).
 */
export type StopFn = () => void;

// ---------------------------------------------------------------------------
// Internal ET-time helpers
// ---------------------------------------------------------------------------

/**
 * Decomposes a UTC `Date` into its field values in the America/New_York
 * timezone using `Intl.DateTimeFormat.formatToParts`.
 *
 * Returns a plain JS `Date` whose `.getFullYear()`, `.getMonth()`,
 * `.getDate()`, `.getHours()`, etc. reflect New York local time.  The
 * returned object's UTC fields do NOT match the original UTC date — only its
 * "local" fields should be used.
 *
 * @param utcDate - The UTC reference date to convert.
 * @returns A `Date` whose local fields mirror the ET wall-clock time.
 */
function toETDate(utcDate: Date): Date {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(utcDate);
  const get = (type: string): number =>
    parseInt(parts.find((p) => p.type === type)?.value ?? "0", 10);

  // hour12:false can yield 24 for midnight in some environments.
  const hour = get("hour") === 24 ? 0 : get("hour");

  return new Date(
    get("year"),
    get("month") - 1,
    get("day"),
    hour,
    get("minute"),
    get("second"),
  );
}

/**
 * Returns today's date string in `"YYYY-MM-DD"` format using Eastern Time.
 *
 * Used to compare against {@link ToolState.lastMarketSummaryDate} to prevent
 * duplicate market-close summaries within a single trading day.
 *
 * @param utcDate - Reference date; defaults to `new Date()` (now).
 * @returns ISO date string for today in ET, e.g. `"2026-03-18"`.
 */
function todayET(utcDate: Date = new Date()): string {
  const et = toETDate(utcDate);
  const y = et.getFullYear();
  const m = String(et.getMonth() + 1).padStart(2, "0");
  const d = String(et.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Classifies the current market state from a Finnhub `isOpen` boolean and
 * the current wall-clock time in Eastern Time.
 *
 * Finnhub's `/stock/market-status` endpoint only returns a boolean `isOpen`
 * field.  This function infers pre-market, after-hours, and overnight-closed
 * states from the ET hour when `isOpen` is `false`.
 *
 * | isOpen | ET hour range          | Returns    |
 * |--------|------------------------|------------|
 * | true   | any                    | `"open"`   |
 * | false  | 04:00–09:29            | `"pre"`    |
 * | false  | 16:00–19:59            | `"after"`  |
 * | false  | all other hours        | `"closed"` |
 *
 * @param isOpen - Whether the regular trading session is currently active.
 * @param nowET  - Current wall-clock time in Eastern Time (from {@link toETDate}).
 * @returns One of `"open" | "pre" | "after" | "closed"`.
 */
function classifyMarketState(
  isOpen: boolean,
  nowET: Date,
): "open" | "pre" | "after" | "closed" {
  if (isOpen) return "open";

  const hour = nowET.getHours();
  const minute = nowET.getMinutes();

  // Pre-market: 04:00 AM – 09:29 AM ET
  if (hour >= 4 && (hour < 9 || (hour === 9 && minute < 30))) return "pre";

  // After-hours: 04:00 PM – 07:59 PM ET
  if (hour >= 16 && hour < 20) return "after";

  return "closed";
}

// ---------------------------------------------------------------------------
// Deduplication helpers
// ---------------------------------------------------------------------------

/**
 * Removes deduplication history entries older than {@link DEDUP_TTL_MS} from
 * `state.dedupHistory` in place.
 *
 * Called at the start of every sync cycle to bound the size of the history
 * array and prevent it growing unboundedly over a long daemon lifetime.
 *
 * @param state - The mutable tool state whose `dedupHistory` array is pruned.
 */
function pruneDedup(state: ToolState): void {
  const cutoff = Date.now() - DEDUP_TTL_MS;
  state.dedupHistory = state.dedupHistory.filter(
    (entry) => entry.firedAt >= cutoff,
  );
}

/**
 * Returns `true` if a signal with the given deduplication key was already
 * emitted within the last {@link DEDUP_TTL_MS} milliseconds.
 *
 * The deduplication key format is `"symbol:signalType:thresholdBracket"`,
 * e.g. `"TSLA:stock_alert:high"` or `"AAPL:stock_milestone:52wkhigh"`.
 *
 * @param state - The tool state containing the rolling `dedupHistory` log.
 * @param key   - Deduplication key to look up.
 * @returns `true` if the key is present and its `firedAt` timestamp is within
 *          the suppression window.
 */
function isDuplicate(state: ToolState, key: string): boolean {
  const cutoff = Date.now() - DEDUP_TTL_MS;
  return state.dedupHistory.some(
    (entry) => entry.key === key && entry.firedAt >= cutoff,
  );
}

/**
 * Records a deduplication key in `state.dedupHistory` with the current Unix
 * millisecond timestamp, suppressing re-emission of the same signal for the
 * next {@link DEDUP_TTL_MS} milliseconds.
 *
 * @param state - The mutable tool state whose `dedupHistory` is appended to.
 * @param key   - Deduplication key to record (see {@link isDuplicate}).
 */
function recordDedup(state: ToolState, key: string): void {
  state.dedupHistory.push({ key, firedAt: Date.now() });
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * Formats a numeric price as a USD string with two decimal places.
 *
 * @param price - Numeric price value (e.g. `185.4`).
 * @returns Formatted string, e.g. `"$185.40"`.
 */
function fmt(price: number): string {
  return `$${price.toFixed(2)}`;
}

/**
 * Formats a percentage change as a signed string with one decimal place.
 *
 * @param pct - Percentage value (e.g. `6.2` for +6.2%, `-3.1` for -3.1%).
 * @returns Formatted string, e.g. `"+6.2%"` or `"-3.1%"`.
 */
function fmtPct(pct: number): string {
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

// ---------------------------------------------------------------------------
// Metrics cache helper
// ---------------------------------------------------------------------------

/**
 * Retrieves cached {@link BasicMetrics} for a symbol from the client's
 * in-memory cache **without** issuing a network request.
 *
 * The sync cycle must not block on a metrics fetch on every tick — metrics
 * are refreshed once per day through a separate staggered background job.
 * Signal conditions that require metrics (52-week range, average volume) are
 * simply skipped for symbols whose metrics have not yet been cached.
 *
 * @param client - The {@link FinnhubClient} whose `metricsCache` is consulted.
 * @param symbol - Ticker symbol in Finnhub format (e.g. `"AAPL"`).
 * @returns The cached {@link BasicMetrics} value, or `null` on a cache miss.
 */
function getCachedMetrics(
  client: FinnhubClient,
  symbol: string,
): BasicMetrics | null {
  const entry = client.metricsCache.get(symbol);
  return entry !== undefined ? entry.data : null;
}

// ---------------------------------------------------------------------------
// Signal evaluation: individual stocks
// ---------------------------------------------------------------------------

/**
 * Evaluates all stock-specific threshold conditions for a single non-index
 * watchlist item and emits qualifying signals via `onSignal`.
 *
 * Conditions evaluated (in priority order — only the highest daily-move tier
 * fires per cycle to avoid duplicate content):
 *
 * 1. **`stock_alert`** — `|changePercent|` exceeds `notableThresholdStock × 2.5`.
 *    Energy: 0.65.
 * 2. **`stock_move`** — `|changePercent|` is between `notableThresholdStock`
 *    and `notableThresholdStock × 2.5` (mutually exclusive with `stock_alert`).
 *    Energy: 0.40.
 * 3. **`stock_milestone`** (52-week high) — `price ≥ fiftyTwoWeekHigh`.
 *    Evaluated independently; may fire alongside a move signal.
 *    Energy: 0.55.
 * 4. **`stock_milestone`** (52-week low) — `price ≤ fiftyTwoWeekLow`.
 *    Mutually exclusive with 52-week-high check. Energy: 0.55.
 * 5. **`stock_volume`** — `volume > 3 × averageVolume10Day`.
 *    Skipped when `quote.volume === 0` (volume unavailable from free tier).
 *    Energy: 0.45.
 *
 * Each qualifying signal is checked against the deduplication log before
 * being emitted and recorded; suppressed signals are silently skipped.
 *
 * @param item     - The watchlist entry being evaluated (must have `isIndex: false`).
 * @param quote    - Latest quote data for `item.symbol`.
 * @param state    - Mutable tool state; `dedupHistory` is updated in place.
 * @param client   - Finnhub client used for metrics cache lookups (no I/O).
 * @param onSignal - Callback invoked for each qualifying, non-duplicate signal.
 */
function evaluateStock(
  item: WatchlistItem,
  quote: Quote,
  state: ToolState,
  client: FinnhubClient,
  onSignal: OnSignalFn,
): void {
  const { notableThresholdStock } = state.settings;
  const absChange = Math.abs(quote.changePercent);
  // Prefer the cached profile name over the static watchlist name.
  const displayName = quote.name ?? item.name;

  // ── Daily-move tier (stock_alert takes priority over stock_move) ──────────
  if (absChange > notableThresholdStock * 2.5) {
    const key = `${item.symbol}:stock_alert:high`;
    if (!isDuplicate(state, key)) {
      const dir = quote.changePercent >= 0 ? "up" : "down";
      onSignal({
        type: "stock_alert",
        symbol: item.symbol,
        name: quote.name,
        energy: 0.65,
        content:
          `${displayName} is ${dir} ${fmtPct(quote.changePercent)} today ` +
          `(${fmt(quote.price)}), exceeding the ` +
          `${fmtPct(notableThresholdStock * 2.5)} alert threshold.`,
        topic: "stocks",
      });
      recordDedup(state, key);
    }
  } else if (absChange >= notableThresholdStock) {
    const key = `${item.symbol}:stock_move:mid`;
    if (!isDuplicate(state, key)) {
      const dir = quote.changePercent >= 0 ? "up" : "down";
      onSignal({
        type: "stock_move",
        symbol: item.symbol,
        name: quote.name,
        energy: 0.4,
        content:
          `${displayName} is ${dir} ${fmtPct(quote.changePercent)} today ` +
          `(${fmt(quote.price)}).`,
        topic: "stocks",
      });
      recordDedup(state, key);
    }
  }

  // ── 52-week milestones (independent of move tier) ─────────────────────────
  const metrics = getCachedMetrics(client, item.symbol);
  if (metrics !== null) {
    if (
      metrics.fiftyTwoWeekHigh > 0 && quote.price >= metrics.fiftyTwoWeekHigh
    ) {
      const key = `${item.symbol}:stock_milestone:52wkhigh`;
      if (!isDuplicate(state, key)) {
        onSignal({
          type: "stock_milestone",
          symbol: item.symbol,
          name: quote.name,
          energy: 0.55,
          content:
            `${displayName} has hit a new 52-week high at ${
              fmt(quote.price)
            } ` +
            `(previous high: ${fmt(metrics.fiftyTwoWeekHigh)}).`,
          topic: "stocks",
        });
        recordDedup(state, key);
      }
    } else if (
      metrics.fiftyTwoWeekLow > 0 &&
      quote.price <= metrics.fiftyTwoWeekLow
    ) {
      const key = `${item.symbol}:stock_milestone:52wklow`;
      if (!isDuplicate(state, key)) {
        onSignal({
          type: "stock_milestone",
          symbol: item.symbol,
          name: quote.name,
          energy: 0.55,
          content:
            `${displayName} has hit a new 52-week low at ${fmt(quote.price)} ` +
            `(previous low: ${fmt(metrics.fiftyTwoWeekLow)}).`,
          topic: "stocks",
        });
        recordDedup(state, key);
      }
    }

    // ── Unusual volume ────────────────────────────────────────────────────────
    if (
      metrics.averageVolume10Day > 0 &&
      quote.volume > 0 &&
      quote.volume > 3 * metrics.averageVolume10Day
    ) {
      const key = `${item.symbol}:stock_volume:vol3x`;
      if (!isDuplicate(state, key)) {
        const ratio = (quote.volume / metrics.averageVolume10Day).toFixed(1);
        onSignal({
          type: "stock_volume",
          symbol: item.symbol,
          name: quote.name,
          energy: 0.45,
          content:
            `${displayName} is seeing unusual trading volume: ${ratio}× its 10-day ` +
            `average (current: ${quote.volume.toLocaleString()}, ` +
            `avg: ${Math.round(metrics.averageVolume10Day).toLocaleString()}).`,
          topic: "stocks",
        });
        recordDedup(state, key);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Signal evaluation: broad market indices / ETF proxies
// ---------------------------------------------------------------------------

/**
 * Evaluates index/ETF-specific threshold conditions for a single watchlist
 * item flagged as `isIndex: true`, and emits qualifying market signals via
 * `onSignal`.
 *
 * Only the highest applicable tier fires per cycle:
 *
 * 1. **`market_alert`** — `|changePercent|` exceeds `notableThresholdIndex × 1.5`.
 *    Energy: 0.65.
 * 2. **`market_move`** — `|changePercent|` is between `notableThresholdIndex`
 *    and `notableThresholdIndex × 1.5`. Energy: 0.35.
 *
 * Uses the same deduplication mechanism as {@link evaluateStock}.
 *
 * @param item     - The watchlist entry (must have `isIndex: true`).
 * @param quote    - Latest quote data for `item.symbol`.
 * @param state    - Mutable tool state; `dedupHistory` updated in place.
 * @param onSignal - Callback invoked for qualifying, non-duplicate signals.
 */
function evaluateIndex(
  item: WatchlistItem,
  quote: Quote,
  state: ToolState,
  onSignal: OnSignalFn,
): void {
  const { notableThresholdIndex } = state.settings;
  const absChange = Math.abs(quote.changePercent);
  const displayName = quote.name ?? item.name;

  if (absChange > notableThresholdIndex * 1.5) {
    const key = `${item.symbol}:market_alert:high`;
    if (!isDuplicate(state, key)) {
      const dir = quote.changePercent >= 0 ? "up" : "down";
      onSignal({
        type: "market_alert",
        symbol: item.symbol,
        name: quote.name,
        energy: 0.65,
        content:
          `${displayName} is ${dir} ${fmtPct(quote.changePercent)} today ` +
          `(${fmt(quote.price)}), a significant broad-market move.`,
        topic: "market",
      });
      recordDedup(state, key);
    }
  } else if (absChange >= notableThresholdIndex) {
    const key = `${item.symbol}:market_move:mid`;
    if (!isDuplicate(state, key)) {
      const dir = quote.changePercent >= 0 ? "up" : "down";
      onSignal({
        type: "market_move",
        symbol: item.symbol,
        name: quote.name,
        energy: 0.35,
        content:
          `${displayName} is ${dir} ${fmtPct(quote.changePercent)} today ` +
          `(${fmt(quote.price)}).`,
        topic: "market",
      });
      recordDedup(state, key);
    }
  }
}

// ---------------------------------------------------------------------------
// MarketSync class
// ---------------------------------------------------------------------------

/**
 * Background polling engine that drives quote fetching, threshold evaluation,
 * and signal emission for the stocks-interface tool.
 *
 * Instantiate once per daemon process and call {@link startSync} to start the
 * loop.  The returned {@link StopFn} cancels all timers for clean shutdown.
 *
 * ### Sync loop internals
 * The loop is implemented with recursive `setTimeout` rather than
 * `setInterval` so that:
 * - A slow network call does not cause cycles to pile up.
 * - The interval can be changed dynamically after each cycle based on the
 *   market state detected in that cycle.
 *
 * ### Polling intervals
 * - **Market open** (`state.settings.syncIntervalMarketOpen`, default 120 s):
 *   used when `classifyMarketState` returns `"open"`.
 * - **Market closed / pre / after** (`state.settings.syncIntervalMarketClosed`,
 *   default 300 s): used for all other states.
 *
 * @example
 * ```ts
 * const sync = new MarketSync();
 * const stop = sync.startSync(
 *   state,
 *   client,
 *   (signal) => chalie.emit(signal),
 *   (quotes) => chalie.summariseDay(quotes),
 * );
 *
 * process.on("SIGTERM", () => { stop(); });
 * ```
 */
export class MarketSync {
  /**
   * Starts the background sync loop and returns a stop function.
   *
   * The first cycle runs immediately (synchronously scheduled via
   * `setTimeout(fn, 0)`) so the caller receives data as soon as possible
   * without blocking the current call stack. This also ensures the daemon-
   * start market-summary check runs within the first event-loop tick.
   *
   * State fields written by this method:
   * - `state.lastKnownMarketState` — updated each cycle from the market-status poll.
   * - `state.lastSyncAt` — set to the ISO timestamp of each successful cycle.
   * - `state.lastMarketSummaryDate` — set when the market-close summary fires.
   * - `state.dedupHistory` — pruned and appended on every cycle.
   *
   * @param state       - Mutable {@link ToolState}. Read and written in place by
   *                      the sync loop. Callers are responsible for persisting
   *                      the state after each cycle (e.g. via `saveState`).
   * @param client      - Configured {@link FinnhubClient} for all Finnhub calls.
   * @param onSignal    - Invoked once per qualifying, non-deduplicated signal.
   * @param onSummary   - Invoked once per trading day at or after 16:00 ET with
   *                      the cycle's quote array for all watchlisted symbols.
   * @param onCycleDone - Optional async callback invoked at the end of each
   *                      successful cycle (after the market-close summary check
   *                      but before the next cycle is scheduled). Useful for
   *                      flushing mutated state to disk without blocking signal
   *                      emission. Errors thrown here propagate to the outer
   *                      `try/catch` and are logged, not silently swallowed.
   * @returns A {@link StopFn} that cancels all pending timers. Idempotent.
   */
  startSync(
    state: ToolState,
    client: FinnhubClient,
    onSignal: OnSignalFn,
    onSummary: OnSummaryFn,
    onCycleDone?: () => Promise<void>,
  ): StopFn {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    /**
     * Executes a single sync cycle:
     * 1. Fetch market status (failures fall back to last known state).
     * 2. Fetch quotes for every watchlisted symbol (per-symbol failures are
     *    logged and skipped; the cycle continues for remaining symbols).
     * 3. Update `state.lastSyncAt`.
     * 4. Prune expired dedup history entries.
     * 5. Evaluate signal thresholds for each successfully fetched quote.
     * 6. Check market-close summary conditions and fire `onSummary` if due.
     * 7. Schedule the next cycle with the appropriate interval.
     */
    const runCycle = async (): Promise<void> => {
      if (stopped) return;

      const now = new Date();
      const nowET = toETDate(now);

      try {
        // ── Step 1: Fetch market status ──────────────────────────────────────
        let isOpen = false;
        try {
          const status = await client.marketStatus();
          isOpen = status.isOpen;
        } catch (err) {
          // A failed status check is non-fatal: use the last known state to
          // avoid switching to a potentially wrong polling interval.
          console.error("[market-sync] Failed to fetch market status:", err);
          isOpen = state.lastKnownMarketState === "open";
        }

        const newMarketState = classifyMarketState(isOpen, nowET);
        const prevMarketState = state.lastKnownMarketState;
        state.lastKnownMarketState = newMarketState;

        // ── Step 2: Fetch quotes for all watchlist symbols ───────────────────
        //
        // All quote requests are issued concurrently via Promise.allSettled so
        // the entire watchlist is fetched in parallel rather than sequentially.
        // Per-symbol failures are logged and skipped; the cycle continues for
        // all other symbols whose requests succeeded.
        const quoteResults = await Promise.allSettled(
          state.watchlist.map((item) => client.quote(item.symbol)),
        );
        const quotes: Quote[] = [];
        for (let i = 0; i < quoteResults.length; i++) {
          const result = quoteResults[i];
          if (result.status === "fulfilled") {
            quotes.push(result.value);
          } else {
            console.error(
              `[market-sync] Failed to fetch quote for ${
                state.watchlist[i].symbol
              }:`,
              result.reason,
            );
          }
        }

        // ── Step 3: Update last-sync timestamp ───────────────────────────────
        state.lastSyncAt = now.toISOString();

        // ── Step 4: Prune expired dedup history ──────────────────────────────
        pruneDedup(state);

        // ── Step 5: Evaluate thresholds and emit signals ─────────────────────
        const quoteMap = new Map<string, Quote>(
          quotes.map((q) => [q.symbol, q] as [string, Quote]),
        );

        for (const item of state.watchlist) {
          const quote = quoteMap.get(item.symbol);
          if (quote === undefined) continue;

          if (item.isIndex) {
            evaluateIndex(item, quote, state, onSignal);
          } else {
            evaluateStock(item, quote, state, client, onSignal);
          }
        }

        // ── Step 5.5: Evaluate user price alerts ─────────────────────────────
        //
        // `checkAlerts` is a pure function — it returns the triggered alerts
        // and an immutably updated state snapshot.  We merge the updated
        // `priceAlerts` array back into the mutable `state` object and emit a
        // `stock_alert` signal for every alert that crossed its threshold this
        // cycle.
        const { triggered, updatedState: alertState } = checkAlerts(
          state,
          quoteMap,
        );
        if (triggered.length > 0) {
          state.priceAlerts = alertState.priceAlerts;
          for (const alert of triggered) {
            const alertQuote = quoteMap.get(alert.symbol);
            if (alertQuote !== undefined) {
              onSignal({
                type: "stock_alert",
                symbol: alert.symbol,
                name: alertQuote.name ?? alert.symbol,
                energy: 0.65,
                content: formatAlertMessage(alert, alertQuote),
                topic: "stocks",
              });
            }
          }
        }

        // ── Step 6: Market close summary ─────────────────────────────────────
        //
        // Fire `onSummary` when ALL of the following hold:
        //  a) Current ET time is at or after 16:00 (market has closed).
        //  b) Today's summary has not yet been emitted (idempotency guard).
        //  c) Either this is the first cycle after daemon start (prevState null),
        //     OR the market state just transitioned from "open" to a non-open
        //     state (regular close detection).
        const todayStr = todayET(now);
        const isAfterClose = nowET.getHours() >= MARKET_CLOSE_HOUR_ET;
        const summaryDue = isAfterClose &&
          state.lastMarketSummaryDate !== todayStr;

        const isTransitionFromOpen = prevMarketState === "open" &&
          newMarketState !== "open";
        const isDaemonStart = prevMarketState === null;

        if (summaryDue && (isTransitionFromOpen || isDaemonStart)) {
          state.lastMarketSummaryDate = todayStr;
          onSummary(quotes);
        }

        // ── Step 6.5: Per-cycle completion hook ──────────────────────────────
        //
        // Awaits the optional `onCycleDone` callback so callers can perform
        // work that must happen after every successful cycle — e.g. persisting
        // the mutated state to disk before the next cycle begins.
        if (onCycleDone !== undefined) {
          await onCycleDone();
        }
      } catch (err) {
        console.error("[market-sync] Unexpected error in sync cycle:", err);
      }

      // ── Step 7: Schedule next cycle ──────────────────────────────────────
      if (!stopped) {
        const interval = state.lastKnownMarketState === "open"
          ? state.settings.syncIntervalMarketOpen
          : state.settings.syncIntervalMarketClosed;

        timer = setTimeout(() => {
          void runCycle();
        }, interval);
      }
    };

    // Kick off the first cycle immediately without blocking the caller.
    timer = setTimeout(() => {
      void runCycle();
    }, 0);

    /**
     * Cancels all pending timers, halting the sync loop.
     *
     * Safe to call multiple times; subsequent calls after the first are
     * no-ops.
     */
    return (): void => {
      stopped = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
  }
}
