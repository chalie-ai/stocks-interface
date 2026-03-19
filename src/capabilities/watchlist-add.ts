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

import {
  FinnhubAuthError,
  FinnhubNetworkError,
} from "../finnhub/client.ts";
import type { FinnhubClient } from "../finnhub/client.ts";
import type { ToolState, WatchlistItem } from "../finnhub/types.ts";
import type { CapabilityResult } from "./stock-quote.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * The three default ETF proxies that represent major US indices.
 * Symbols in this set receive `isIndex: true` regardless of `params.type`,
 * ensuring they are evaluated against the (lower) index alert threshold.
 */
const INDEX_ETF_PROXIES = new Set<string>(["SPY", "QQQ", "DIA"]);

// ---------------------------------------------------------------------------
// Exported handler
// ---------------------------------------------------------------------------

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
export async function handleWatchlistAdd(
  params: { symbol: string; type?: WatchlistItem["type"] },
  client: FinnhubClient,
  state: ToolState,
): Promise<{ result: CapabilityResult; updatedState: ToolState }> {
  const symbol = params.symbol.toUpperCase().trim();

  // ── Step 1: Validate symbol via Finnhub quote endpoint ──────────────────
  try {
    const quote = await client.quote(symbol);

    // Finnhub returns HTTP 200 with all-zero fields for unrecognised symbols
    // (no 404 is issued). A zero price combined with a zero timestamp is the
    // reliable "not found" signal on the free tier.
    if (quote.price === 0 && quote.timestamp === 0) {
      return buildErrorResult(
        `Symbol ${symbol} not found on Finnhub. Please check the ticker and try again.`,
        state,
      );
    }
  } catch (err: unknown) {
    if (err instanceof FinnhubAuthError) {
      return buildErrorResult(
        "This API key doesn't seem to work. Please double-check you copied the full key.",
        state,
      );
    }
    if (err instanceof FinnhubNetworkError) {
      return buildErrorResult(
        "Couldn't reach Finnhub to verify symbol. Please check your internet connection.",
        state,
      );
    }
    // FinnhubApiError (500-range, rate-limit, etc.) or unexpected error.
    const msg = err instanceof Error ? err.message : String(err);
    return buildErrorResult(
      `Finnhub seems to be having issues right now (${msg}). Please try again shortly.`,
      state,
    );
  }

  // ── Step 2: Reject duplicates (case-insensitive) ─────────────────────────
  const alreadyExists = state.watchlist.some(
    (item) => item.symbol.toUpperCase() === symbol,
  );
  if (alreadyExists) {
    return buildErrorResult(
      `${symbol} is already in your watchlist.`,
      state,
    );
  }

  // ── Step 3: Enforce maxWatchlistSize ─────────────────────────────────────
  const maxSize = state.settings.maxWatchlistSize;
  if (state.watchlist.length >= maxSize) {
    return buildErrorResult(
      `Your watchlist is full (${maxSize} symbols maximum). ` +
        "Remove a symbol before adding a new one.",
      state,
    );
  }

  // ── Step 4: Determine isIndex and item type ──────────────────────────────
  const specifiedType = params.type;
  const isIndex =
    INDEX_ETF_PROXIES.has(symbol) ||
    specifiedType === "index" ||
    specifiedType === "etf";

  // Prefer the caller-supplied type; fall back to "etf" for index-proxies and
  // "stock" for everything else.
  const itemType: WatchlistItem["type"] =
    specifiedType ?? (isIndex ? "etf" : "stock");

  // ── Step 5: Resolve display name and exchange via companyProfile ──────────
  // companyProfile also populates profileCache as a side-effect, so future
  // quote() calls will resolve Quote.name without an extra API round-trip.
  let displayName = symbol; // Fallback: use symbol if profile fetch fails.
  let exchange = "US";

  try {
    const profile = await client.companyProfile(symbol);
    if (profile.name.length > 0) {
      displayName = profile.name;
    }
    if (profile.exchange.length > 0) {
      exchange = profile.exchange;
    }
  } catch {
    // Profile fetch is best-effort. The item is still added with symbol as
    // the display name. The sync layer will retry the profile on the next
    // daily cache refresh cycle.
  }

  // ── Step 6: Build and append the new watchlist item ──────────────────────
  const newItem: WatchlistItem = {
    symbol,
    name: displayName,
    exchange,
    type: itemType,
    addedAt: new Date().toISOString(),
    isIndex,
  };

  const updatedState: ToolState = {
    ...state,
    watchlist: [...state.watchlist, newItem],
  };

  // ── Step 7: Fire-and-forget basicMetrics pre-fetch (priority 3) ──────────
  // Staggered background warm-up so the 52-week range and volume baseline are
  // available before the next sync cycle. Errors are silently swallowed — a
  // failed pre-fetch is not a reason to fail the add operation.
  void client.basicMetrics(symbol).catch(() => undefined);

  // ── Step 8: Build success result ─────────────────────────────────────────
  const indexNote = isIndex ? " · index thresholds apply" : "";
  const text =
    `Added ${symbol} (${displayName}) to your watchlist. ` +
    `Type: ${itemType}${indexNote}. ` +
    `Watchlist now has ${updatedState.watchlist.length} of ${maxSize} slots used.`;

  const html = buildSuccessHtml(newItem, updatedState.watchlist.length, maxSize);

  return { result: { text, html }, updatedState };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Builds a standardised error {@link CapabilityResult} paired with the
 * unchanged input state, so callers always receive the same return shape
 * regardless of whether the operation succeeded or failed.
 *
 * @param message - Human-readable error message displayed to the user.
 * @param state   - The unchanged input state returned as `updatedState`.
 * @returns `{ result, updatedState }` with `result.error` set.
 */
function buildErrorResult(
  message: string,
  state: ToolState,
): { result: CapabilityResult; updatedState: ToolState } {
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

/**
 * Builds the success HTML card displayed after a symbol is added.
 *
 * The card shows the symbol, resolved display name, exchange, type
 * classification, and remaining watchlist capacity.
 *
 * @param item      - The newly added {@link WatchlistItem}.
 * @param newSize   - The watchlist size after the addition.
 * @param maxSize   - The maximum allowed watchlist size.
 * @returns An inline-CSS HTML fragment safe for rendering in the Chalie UI.
 */
function buildSuccessHtml(
  item: WatchlistItem,
  newSize: number,
  maxSize: number,
): string {
  const indexBadge = item.isIndex
    ? `<span style="font-size:11px;font-weight:600;padding:2px 7px;border-radius:10px;
           background:rgba(0,137,123,0.12);color:#00695c;margin-left:8px">
         INDEX
       </span>`
    : "";

  return `
<div style="font-family:system-ui,sans-serif;background:#fff;border:1px solid #bbf7d0;
    border-radius:8px;padding:16px;max-width:480px;
    box-shadow:0 1px 3px rgba(0,0,0,0.06)">

  <!-- Header -->
  <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
    <span style="font-size:16px">✅</span>
    <span style="font-size:15px;font-weight:700;color:#15803d">
      ${escapeHtml(item.symbol)} added to watchlist
    </span>
    ${indexBadge}
  </div>

  <!-- Detail rows -->
  <table style="width:100%;border-collapse:collapse;font-size:13px;color:#374151">
    <tbody>
      <tr style="border-top:1px solid #f0fdf4">
        <td style="padding:5px 4px;color:#6b7280;width:120px">Name</td>
        <td style="padding:5px 4px;font-weight:500">${escapeHtml(item.name)}</td>
      </tr>
      <tr style="border-top:1px solid #f0fdf4">
        <td style="padding:5px 4px;color:#6b7280">Exchange</td>
        <td style="padding:5px 4px;font-weight:500">${escapeHtml(item.exchange)}</td>
      </tr>
      <tr style="border-top:1px solid #f0fdf4">
        <td style="padding:5px 4px;color:#6b7280">Type</td>
        <td style="padding:5px 4px;font-weight:500">${escapeHtml(item.type)}${item.isIndex ? " · index thresholds" : ""}</td>
      </tr>
      <tr style="border-top:1px solid #f0fdf4">
        <td style="padding:5px 4px;color:#6b7280">Watchlist</td>
        <td style="padding:5px 4px;font-weight:500">${newSize} / ${maxSize} slots used</td>
      </tr>
    </tbody>
  </table>
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
