/**
 * @file src/capabilities/stock-history.ts
 * @description Capability handler that fetches OHLCV candlestick history for a
 * single symbol and renders a price-history card with an inline SVG sparkline.
 *
 * Invoked by the Chalie reasoning layer when the user asks about historical
 * performance (e.g. "How has AAPL done over the last 30 days?"). The LLM maps
 * natural-language time expressions to the strict {@link HistoryPeriod} enum —
 * this handler accepts only the enum values and does **not** parse free-text.
 *
 * ## Data sources
 * - **OHLCV candles** — `GET /stock/candle` with daily resolution (`"D"`) via
 *   {@link FinnhubClient.candles}. One API call per invocation.
 *
 * ## SVG sparkline
 * The sparkline is rendered as an inline `<polyline>` element with no external
 * libraries. Close prices are normalised into SVG viewport coordinates using a
 * min/max linear scale. Line colour is green for a positive period return and
 * red for a negative one.
 *
 * ## Period semantics
 * | Period | `from` timestamp | `to` timestamp |
 * |--------|-----------------|----------------|
 * | `"7d"` | now − 7 days | now |
 * | `"30d"` | now − 30 days | now |
 * | `"90d"` | now − 90 days | now |
 * | `"1y"` | now − 365 days | now |
 * | `"ytd"` | Jan 1 00:00 UTC of the current year | now |
 *
 * @module stocks-interface/capabilities/stock-history
 */
import type { FinnhubClient } from "../finnhub/client.js";
import type { ToolState } from "../finnhub/types.js";
import type { CapabilityResult } from "./stock-quote.js";
/**
 * Accepted period values for {@link handleStockHistory}.
 *
 * The LLM maps natural-language expressions to these values before invoking
 * the handler. This type is intentionally a strict enum — no free-text parsing
 * is performed inside the handler.
 */
export type HistoryPeriod = "7d" | "30d" | "90d" | "1y" | "ytd";
/**
 * Fetches daily OHLCV candle data for a symbol over the requested period and
 * returns a rich history card alongside a plain-text summary.
 *
 * ### HTML card contents
 * - Symbol and period label in the header
 * - Total return percentage (colour-coded; positive = green, negative = red)
 * - Inline SVG sparkline rendered from daily close prices
 * - Start price, end price, period high, period low, and total return % in a
 *   stats grid
 *
 * ### Period resolution
 * All periods use Finnhub's **daily** (`"D"`) candle resolution. Intraday
 * candles are not used because they are not needed for the supported periods
 * and would consume significantly more API quota.
 *
 * ### No-data handling
 * When Finnhub returns `status: "no_data"` (e.g. for very new symbols or
 * holidays filling the entire range), a user-friendly message is returned
 * without an `error` field (it is expected and not an API error).
 *
 * ### Error handling
 * On any Finnhub error the function resolves (not rejects) with a
 * {@link CapabilityResult} that has `error` set and a user-facing HTML message.
 *
 * @param params        - Handler parameters.
 * @param params.symbol - Ticker symbol to look up (case-insensitive; normalised
 *   to upper-case internally).
 * @param params.period - Time period for the history query. Must be one of the
 *   {@link HistoryPeriod} enum values. Natural-language mapping is performed by
 *   the LLM before this function is called — no NL parsing is done here.
 * @param client        - Configured {@link FinnhubClient} instance.
 * @param _state        - Current {@link ToolState}. Accepted for interface
 *   consistency with other capability handlers; not used by this handler.
 * @returns A resolved {@link CapabilityResult} — never rejects.
 *
 * @example
 * ```ts
 * const result = await handleStockHistory(
 *   { symbol: "AAPL", period: "30d" },
 *   client,
 *   state,
 * );
 * console.log(result.text);
 * // "AAPL — 30 Days History: Start $162.00, End $178.50, Return +10.19% | ..."
 * ```
 */
export declare function handleStockHistory(params: {
    symbol: string;
    period: HistoryPeriod;
}, client: FinnhubClient, _state: ToolState): Promise<CapabilityResult>;
//# sourceMappingURL=stock-history.d.ts.map