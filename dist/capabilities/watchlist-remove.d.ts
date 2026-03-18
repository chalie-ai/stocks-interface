/**
 * @file src/capabilities/watchlist-remove.ts
 * @description Capability handler that removes a symbol from the user's watchlist.
 *
 * Invoked by the Chalie reasoning layer when the user asks to stop tracking a
 * ticker (e.g. "Remove NVDA from my watchlist" or "Stop tracking DIA").
 *
 * ## Behaviour
 * - Symbol matching is **case-insensitive** so `"aapl"`, `"AAPL"`, and `"Aapl"`
 *   all target the same watchlist entry.
 * - If the symbol is not present in the watchlist, an error result is returned
 *   and `updatedState` is identical to the input `state` (no mutation).
 * - The operation is synchronous — no API calls are made.
 * - Any active {@link PriceAlert} records for the removed symbol are **not**
 *   automatically deleted; the user must explicitly remove alerts separately.
 *   This is intentional: it preserves the user's alert history for review.
 *
 * @module stocks-interface/capabilities/watchlist-remove
 */
import type { ToolState } from "../finnhub/types.js";
import type { CapabilityResult } from "./stock-quote.js";
/**
 * Removes a symbol from the user's watchlist.
 *
 * Returns both a {@link CapabilityResult} for Chalie's reasoning context and
 * an `updatedState` with the symbol excised. The caller is responsible for
 * persisting `updatedState` via `saveState()`.
 *
 * On failure (symbol not found) the function returns an appropriate
 * {@link CapabilityResult} with `error` set, and `updatedState` is identical
 * to the input `state` (no mutation).
 *
 * The function is synchronous because no network calls are required.
 *
 * @param params        - Handler parameters.
 * @param params.symbol - Ticker symbol to remove (case-insensitive; matched
 *   against all watchlist entries using upper-case normalisation).
 * @param state         - Current {@link ToolState} whose `watchlist` array is
 *   searched and, on success, returned as a filtered copy in `updatedState`.
 * @returns An object containing:
 *   - `result` — a {@link CapabilityResult} with `text` + `html` (and
 *     optionally `error` on failure).
 *   - `updatedState` — the mutated state (or unchanged state on error).
 *
 * @example
 * ```ts
 * const { result, updatedState } = handleWatchlistRemove({ symbol: "NVDA" }, state);
 * await saveState(dataDir, updatedState);
 * ```
 */
export declare function handleWatchlistRemove(params: {
    symbol: string;
}, state: ToolState): {
    result: CapabilityResult;
    updatedState: ToolState;
};
//# sourceMappingURL=watchlist-remove.d.ts.map