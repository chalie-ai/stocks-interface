/**
 * @file src/capabilities/stock-quote.ts
 * @description Capability handler that fetches and renders a real-time stock
 * quote card for a single symbol.
 *
 * Invoked by the Chalie reasoning layer when the user asks for a price or
 * summary of a specific ticker (e.g. "What is Apple trading at?").
 *
 * ## Data sources
 * - **Price data** — `GET /quote` via {@link FinnhubClient.quote}.
 * - **Company name** — resolved from `client.profileCache` (pre-warmed by the
 *   sync cycle); `"N/A"` is shown on a cache miss without blocking the call.
 *
 * ## Live / Delayed badge
 * The badge reflects `state.lastKnownMarketState`:
 * - `"open"` → **Live** (green badge): data was just fetched during an active
 *   trading session.
 * - All other states (`"pre"`, `"after"`, `"closed"`, `null`) → **Delayed**
 *   (amber badge): the market is not in its regular trading session so the
 *   price shown is the most-recent available tick, not a real-time feed.
 *
 * @module stocks-interface/capabilities/stock-quote
 */
import type { FinnhubClient } from "../finnhub/client.js";
import type { ToolState } from "../finnhub/types.js";
/**
 * The result returned by every capability handler in this tool.
 *
 * Both `text` and `html` representations are always populated on success so
 * Chalie can choose the best rendering surface. `error` is set only when the
 * handler could not complete the request.
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
     * Human-readable error message when the handler failed.
     * Absent on success. `text` and `html` will contain user-facing error copy
     * even when this field is set.
     */
    error?: string;
}
/**
 * Fetches a real-time quote for a single symbol and returns a rich HTML card
 * alongside a plain-text summary for Chalie's reasoning context.
 *
 * ### HTML card contents
 * - Symbol and company name (or `"N/A"` on profile-cache miss)
 * - Live / Delayed badge (derived from `state.lastKnownMarketState`)
 * - Current price with signed change and percentage change (colour-coded)
 * - Day high / low, open, previous close
 * - Intraday volume (shown as `"N/A"` on the Finnhub free tier because the
 *   `/quote` endpoint does not return volume)
 *
 * ### Error handling
 * On any Finnhub error the function resolves (not rejects) with a
 * {@link CapabilityResult} that has `error` set. The `html` field contains a
 * user-friendly error message safe to render in the UI.
 *
 * @param params  - Handler parameters.
 * @param params.symbol - Ticker symbol to look up (case-insensitive;
 *   normalised to upper-case internally).
 * @param client  - Configured {@link FinnhubClient} instance with its
 *   profile cache pre-warmed by the sync layer.
 * @param state   - Current {@link ToolState}; `lastKnownMarketState` drives
 *   the Live / Delayed badge.
 * @returns A resolved {@link CapabilityResult} — never rejects.
 *
 * @example
 * ```ts
 * const result = await handleStockQuote({ symbol: "AAPL" }, client, state);
 * console.log(result.text);
 * // "AAPL (Apple Inc): $178.50 +2.35 (+1.33%) | Day range: $176.10–$179.80 | ..."
 * ```
 */
export declare function handleStockQuote(params: {
    symbol: string;
}, client: FinnhubClient, state: ToolState): Promise<CapabilityResult>;
//# sourceMappingURL=stock-quote.d.ts.map