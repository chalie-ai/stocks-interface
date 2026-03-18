/**
 * @file src/capabilities/stock-compare.ts
 * @description Capability handler that compares up to five stocks side-by-side
 * in a sortable HTML table card.
 *
 * Invoked by the Chalie reasoning layer when the user asks to compare multiple
 * tickers (e.g. "Compare AAPL, MSFT, and GOOGL").
 *
 * ## Data sources
 * - **Quotes** — `GET /quote` via {@link FinnhubClient.quote} (one call per symbol).
 * - **P/E ratio** — sourced from `client.metricsCache` via
 *   {@link FinnhubClient.basicMetrics}, which is refreshed once per trading day.
 *   The P/E value shown is therefore **daily-stale** — it reflects the end-of-prior-
 *   day calculation, not a real-time figure. A footnote is included in the card.
 *   Displays `"N/A"` when the metric is unavailable (e.g. negative earnings, ETFs)
 *   or when the network request for metrics failed.
 *
 * ## Partial failure model
 * Quote and metrics fetches use `Promise.allSettled` so a single failed symbol
 * does not abort the whole comparison. Failed symbols appear in the table with
 * `"Error"` cells and the top-level `error` field summarises which symbols could
 * not be retrieved.
 *
 * ## Live / Delayed badge
 * A single badge is shown in the card header, derived from
 * `state.lastKnownMarketState` (same logic as {@link handleStockQuote}).
 *
 * @module stocks-interface/capabilities/stock-compare
 */
import type { FinnhubClient } from "../finnhub/client.js";
import type { ToolState } from "../finnhub/types.js";
/**
 * The result returned by every capability handler in this tool.
 *
 * Both `text` and `html` representations are always populated on success so
 * Chalie can choose the best rendering surface. `error` is set only when the
 * handler could not fully complete the request.
 */
export interface CapabilityResult {
    /** Plain-text summary suitable for Chalie's reasoning context. */
    text: string;
    /**
     * Inline-CSS HTML card for rich rendering in the Chalie UI.
     * Never contains `<script>` tags.
     */
    html: string;
    /**
     * Human-readable error message when the handler failed or produced only
     * partial results. Absent when all symbols were resolved successfully.
     */
    error?: string;
}
/**
 * Fetches quotes (and cached P/E metrics) for up to {@link MAX_SYMBOLS} symbols
 * and returns a side-by-side comparison table as both an HTML card and a
 * plain-text summary.
 *
 * ### Columns
 * | Column | Source | Notes |
 * |--------|--------|-------|
 * | Symbol / Name | `Quote.symbol`, `Quote.name` | Name from profile cache |
 * | Price | `Quote.price` | Current price |
 * | Change % | `Quote.changePercent` | Intraday, colour-coded |
 * | Day Range | `Quote.low`–`Quote.high` | Session high / low |
 * | P/E | `BasicMetrics.peRatio` | **Daily-cached** — stale up to 24 h; `"N/A"` for ETFs, negative-earnings stocks, or fetch failures |
 *
 * ### Partial failure handling
 * Symbols whose quote fetch fails are still shown in the table with an inline
 * error message. The top-level `error` field is set when one or more symbols
 * could not be resolved.
 *
 * @param params          - Handler parameters.
 * @param params.symbols  - Array of ticker symbols to compare (case-insensitive;
 *   normalised to upper-case internally). Silently truncated to
 *   {@link MAX_SYMBOLS} entries if more are supplied.
 * @param client          - Configured {@link FinnhubClient} instance. Quote and
 *   metrics fetches are dispatched concurrently via `Promise.allSettled`.
 * @param state           - Current {@link ToolState}; `lastKnownMarketState`
 *   drives the Live / Delayed badge.
 * @returns A resolved {@link CapabilityResult} — never rejects.
 *
 * @example
 * ```ts
 * const result = await handleStockCompare(
 *   { symbols: ["AAPL", "MSFT", "GOOGL"] },
 *   client,
 *   state,
 * );
 * console.log(result.text);
 * // "Comparison (3 stocks): AAPL $178.50 +1.33% P/E 29.12 | ..."
 * ```
 */
export declare function handleStockCompare(params: {
    symbols: string[];
}, client: FinnhubClient, state: ToolState): Promise<CapabilityResult>;
//# sourceMappingURL=stock-compare.d.ts.map