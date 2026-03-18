/**
 * @file src/capabilities/watchlist-add.ts
 * @description Capability handler that adds a symbol to the user's watchlist.
 *
 * Invoked by the Chalie reasoning layer when the user asks to track a new
 * ticker (e.g. "Add NVDA to my watchlist").
 *
 * ## Validation steps (in order)
 * 1. Call `client.quote(symbol)` to confirm the symbol exists on Finnhub.
 *    - HTTP 401 → auth-key error message.
 *    - Network failure → connectivity error message.
 *    - All-zero quote (Finnhub's signal for unknown symbols) → "not found" message.
 * 2. Reject if the symbol already appears in the watchlist (case-insensitive).
 * 3. Reject if the watchlist has reached `state.settings.maxWatchlistSize`.
 *
 * ## Name resolution
 * After validation, `client.companyProfile()` is called to populate the
 * display name and exchange. On failure the symbol itself is used as the
 * display name so the add operation is never blocked by a profile fetch error.
 * The call to `companyProfile` also warms `client.profileCache` as a side-
 * effect, so subsequent `quote()` calls resolve `Quote.name` immediately.
 *
 * ## isIndex determination
 * A symbol is flagged `isIndex: true` when:
 * - It is one of the three default index-proxy ETFs (`SPY`, `QQQ`, `DIA`), OR
 * - The caller supplied `params.type === "index"` or `"etf"`.
 *
 * ## Background pre-fetches
 * After a successful add, `client.basicMetrics()` is fired as a
 * fire-and-forget (priority 3) so the 52-week high/low and average volume
 * baseline are available before the next sync cycle.
 *
 * @module stocks-interface/capabilities/watchlist-add
 */
import type { FinnhubClient } from "../finnhub/client.js";
import type { ToolState, WatchlistItem } from "../finnhub/types.js";
import type { CapabilityResult } from "./stock-quote.js";
/**
 * Adds a symbol to the user's watchlist after validating it against Finnhub.
 *
 * Returns both a {@link CapabilityResult} for Chalie's reasoning context and
 * an `updatedState` with the symbol appended. The caller is responsible for
 * persisting `updatedState` via `saveState()`.
 *
 * On any validation failure the function resolves (never rejects) with an
 * appropriate {@link CapabilityResult} containing a user-facing error message,
 * and `updatedState` is identical to the input `state` (no mutation).
 *
 * @param params          - Handler parameters.
 * @param params.symbol   - Ticker symbol to add (case-insensitive; normalised
 *   to upper-case internally before all comparisons and storage).
 * @param params.type     - Optional symbol type hint supplied by the LLM.
 *   When `"index"` or `"etf"`, the new item is flagged `isIndex: true` even
 *   if the symbol is not one of the three default ETF proxies.
 * @param client          - Configured {@link FinnhubClient} used for symbol
 *   validation (`quote`), name resolution (`companyProfile`), and background
 *   metrics pre-fetch (`basicMetrics`).
 * @param state           - Current {@link ToolState}; watchlist and settings
 *   are read from here.
 * @returns An object containing:
 *   - `result` — a {@link CapabilityResult} with `text` + `html` (and
 *     optionally `error` on failure).
 *   - `updatedState` — the mutated state (or unchanged state on error).
 *
 * @example
 * ```ts
 * const { result, updatedState } = await handleWatchlistAdd(
 *   { symbol: "NVDA" },
 *   client,
 *   state,
 * );
 * await saveState(dataDir, updatedState);
 * ```
 */
export declare function handleWatchlistAdd(params: {
    symbol: string;
    type?: WatchlistItem["type"];
}, client: FinnhubClient, state: ToolState): Promise<{
    result: CapabilityResult;
    updatedState: ToolState;
}>;
//# sourceMappingURL=watchlist-add.d.ts.map