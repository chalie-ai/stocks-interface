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
import type { FinnhubClient } from "../finnhub/client.js";
import type { Quote, ToolState } from "../finnhub/types.js";
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
    type: "stock_alert" | "stock_move" | "stock_milestone" | "stock_volume" | "market_alert" | "market_move" | "market_summary";
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
export declare class MarketSync {
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
     * @param state     - Mutable {@link ToolState}. Read and written in place by
     *                    the sync loop. Callers are responsible for persisting
     *                    the state after each cycle (e.g. via `saveState`).
     * @param client    - Configured {@link FinnhubClient} for all Finnhub calls.
     * @param onSignal  - Invoked once per qualifying, non-deduplicated signal.
     * @param onSummary - Invoked once per trading day at or after 16:00 ET with
     *                    the cycle's quote array for all watchlisted symbols.
     * @returns A {@link StopFn} that cancels all pending timers. Idempotent.
     */
    startSync(state: ToolState, client: FinnhubClient, onSignal: OnSignalFn, onSummary: OnSummaryFn): StopFn;
}
//# sourceMappingURL=market-sync.d.ts.map