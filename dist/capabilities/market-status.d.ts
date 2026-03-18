/**
 * @file src/capabilities/market-status.ts
 * @description Capability handlers for US market status and earnings calendar.
 *
 * Exports two public handlers:
 *
 * ### `handleMarketStatus`
 * Fetches the current open/closed state of the US equity market and renders an
 * HTML card showing:
 * - Market phase label (Open · Pre-Market · After-Hours · Closed)
 * - Current time in US Eastern Time (ET)
 * - Holiday notice when the market is closed due to a named holiday
 * - Index ETF summary (SPY, QQQ, DIA) — prices and change% fetched from the
 *   Finnhub API via fresh quote calls, or "data unavailable" on fetch failure
 * - Next scheduled market open or close time, shown in both ET and the
 *   process's local timezone (which equals the user's timezone when the tool
 *   runs on their machine)
 *
 * ### `handleEarningsCalendar`
 * Fetches upcoming earnings events from Finnhub's `GET /calendar/earnings`
 * endpoint for the next `daysAhead` calendar days (default: 7). When a
 * `symbol` is provided, results are filtered to that ticker. Displays the
 * report date, pre/post-market timing, and EPS estimate for each event.
 *
 * ## HTML constraints
 * All HTML is rendered with inline CSS only. No `<script>` tags are emitted.
 *
 * @module stocks-interface/capabilities/market-status
 */
import type { FinnhubClient } from "../finnhub/client.js";
import type { ToolState } from "../finnhub/types.js";
import type { CapabilityResult } from "./stock-quote.js";
/**
 * Fetches the current US market status and renders a rich HTML card.
 *
 * ### Card contents
 * - Market phase badge: Open · Pre-Market · After-Hours · Closed
 * - Current time in ET (24-hour clock)
 * - Holiday notice when `marketStatus.holiday` is non-null
 * - Index ETF summary table: SPY, QQQ, DIA with live price and % change
 *   (fetched via fresh `client.quote()` calls; shows "Data unavailable" on
 *   fetch failure or if all three fail)
 * - Next market event: close time (when open) or open time (when closed),
 *   formatted in both ET and the user's local timezone
 *
 * ### Error handling
 * The function always resolves (never rejects). A Finnhub error on the
 * market-status call returns a result with `error` set and an error card.
 * Index quote failures are handled individually — failed symbols show
 * "Data unavailable" inline rather than aborting the entire card.
 *
 * @param params  - No parameters required; pass `{}`.
 * @param client  - Configured {@link FinnhubClient} instance.
 * @param state   - Current {@link ToolState} (used for last-known market state
 *                  context; not mutated by this function).
 * @returns A resolved {@link CapabilityResult} — never rejects.
 *
 * @example
 * ```ts
 * const result = await handleMarketStatus({}, client, state);
 * console.log(result.text); // "Market: Open | 2:45 PM ET | SPY $523.14 +0.32% …"
 * ```
 */
export declare function handleMarketStatus(_params: Record<string, never>, client: FinnhubClient, _state: ToolState): Promise<CapabilityResult>;
/**
 * Fetches upcoming earnings events and renders a rich HTML card.
 *
 * ### Card contents
 * - One row per earnings event: symbol, report date, pre/post-market timing,
 *   estimated EPS, and actual EPS (if already reported)
 * - Filtered to `params.symbol` when supplied
 * - An "empty state" message when no earnings are scheduled in the window
 *
 * ### Finnhub endpoint
 * `GET /calendar/earnings?from=YYYY-MM-DD&to=YYYY-MM-DD[&symbol=XXXX]`
 *
 * The `from` date is today's ET date; `to` is today + `daysAhead` calendar
 * days. Both dates are derived from the current ET clock rather than UTC to
 * align with the US market calendar.
 *
 * ### Error handling
 * Always resolves. On API error the result has `error` set and the `html`
 * field shows a user-friendly error message.
 *
 * @param params            - Handler parameters.
 * @param params.symbol     - Optional ticker to filter to (case-insensitive).
 *   When absent, all symbols with earnings in the window are shown.
 * @param params.daysAhead  - Number of calendar days ahead to include
 *   (default: `7`; minimum: `1`; maximum: `30` to limit result size).
 * @param client            - Configured {@link FinnhubClient} instance.
 * @param _state            - Current {@link ToolState} (unused; included for
 *   handler-signature consistency).
 * @returns A resolved {@link CapabilityResult} — never rejects.
 *
 * @example
 * ```ts
 * const result = await handleEarningsCalendar({ symbol: "AAPL", daysAhead: 14 }, client, state);
 * console.log(result.text);
 * // "Upcoming earnings (next 14 days): AAPL — Jan 26 · After Close · Est. EPS: $1.94"
 * ```
 */
export declare function handleEarningsCalendar(params: {
    symbol?: string;
    daysAhead?: number;
}, client: FinnhubClient, _state: ToolState): Promise<CapabilityResult>;
//# sourceMappingURL=market-status.d.ts.map