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

import type { ToolState } from "../finnhub/types.ts";
import type { CapabilityResult } from "./stock-quote.ts";

// ---------------------------------------------------------------------------
// Exported handler
// ---------------------------------------------------------------------------

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
export function handleWatchlistRemove(
  params: { symbol: string },
  state: ToolState,
): { result: CapabilityResult; updatedState: ToolState } {
  const symbol = params.symbol.toUpperCase().trim();

  // ── Find the target item (case-insensitive) ───────────────────────────────
  const itemIndex = state.watchlist.findIndex(
    (item) => item.symbol.toUpperCase() === symbol,
  );

  if (itemIndex === -1) {
    const message = `${symbol} is not in your watchlist.`;
    const html = `
<div style="font-family:system-ui,sans-serif;background:#fff;border:1px solid #fecaca;
    border-radius:8px;padding:16px;max-width:480px">
  <p style="margin:0;color:#dc2626;font-size:14px">
    ${escapeHtml(message)}
  </p>
</div>`.trim();

    return {
      result: { text: message, html, error: message },
      updatedState: state,
    };
  }

  // ── Remove the item and build updated state ───────────────────────────────
  // Use non-null assertion: itemIndex is valid because findIndex returned ≥ 0.
  const removedItem = state.watchlist[itemIndex]!;
  const updatedWatchlist = state.watchlist.filter((_, i) => i !== itemIndex);

  const updatedState: ToolState = {
    ...state,
    watchlist: updatedWatchlist,
  };

  // ── Build success result ──────────────────────────────────────────────────
  const remainingCount = updatedWatchlist.length;
  const text =
    `Removed ${removedItem.symbol} (${removedItem.name}) from your watchlist. ` +
    `${remainingCount} symbol${remainingCount !== 1 ? "s" : ""} remaining.`;

  const html = buildSuccessHtml(
    removedItem.symbol,
    removedItem.name,
    remainingCount,
  );

  return { result: { text, html }, updatedState };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Builds the success HTML card displayed after a symbol is removed.
 *
 * @param symbol         - The removed ticker symbol (already upper-case).
 * @param name           - The display name of the removed symbol.
 * @param remainingCount - Number of symbols left in the watchlist after removal.
 * @returns An inline-CSS HTML fragment safe for rendering in the Chalie UI.
 */
function buildSuccessHtml(
  symbol: string,
  name: string,
  remainingCount: number,
): string {
  const remainingLabel = remainingCount === 0
    ? "Your watchlist is now empty."
    : `${remainingCount} symbol${
      remainingCount !== 1 ? "s" : ""
    } remaining in your watchlist.`;

  return `
<div style="font-family:system-ui,sans-serif;background:#fff;border:1px solid #e5e7eb;
    border-radius:8px;padding:16px;max-width:480px;
    box-shadow:0 1px 3px rgba(0,0,0,0.06)">

  <!-- Header -->
  <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
    <span style="font-size:16px">🗑️</span>
    <span style="font-size:15px;font-weight:700;color:#374151">
      ${escapeHtml(symbol)} removed from watchlist
    </span>
  </div>

  <!-- Detail -->
  <div style="font-size:13px;color:#6b7280;line-height:1.6">
    <div>${escapeHtml(name)} is no longer being tracked.</div>
    <div style="margin-top:4px;color:#9ca3af">${
    escapeHtml(remainingLabel)
  }</div>
  </div>
</div>`.trim();
}

/**
 * Escapes a string for safe interpolation into an HTML text node or attribute.
 *
 * @param str - Raw string to escape.
 * @returns HTML-safe string with `&`, `<`, `>`, `"`, and `'` replaced by
 *   their named HTML entity equivalents.
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
