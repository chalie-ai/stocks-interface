/**
 * @file src/ui/main.ts
 * @description Main dashboard HTML card renderer for the stocks-interface tool.
 *
 * Exports {@link renderMainView}, the single entry-point for generating the
 * full dashboard HTML fragment. The output varies based on the {@link ViewState}
 * argument:
 *
 *  - `"loading"` — skeleton placeholder cards while the first sync cycle runs.
 *  - `"error"`   — a banner explaining the connectivity failure, with the last
 *                  successful sync time and a gear-icon link to settings.
 *  - `"empty"`   — the empty-watchlist prompt plus stocks-only suggested prompts.
 *  - `"ready"`   — a compact index summary row, the full watchlist section for
 *                  non-index items, and the active price-alert count.
 *
 * HTML contract (09-TOOLS.md):
 *  - Inline CSS only — no `<style>` blocks, no external stylesheets.
 *  - No JavaScript — no `<script>` tags, no event handlers, no `javascript:` URIs.
 *  - Fragment only — no `<html>`, `<head>`, or `<body>` tags.
 *  - Interactive controls use `data-*` attributes only; wiring is handled by
 *    the Chalie tool runtime.
 *
 * @module stocks-interface/ui/main
 */

import type { Quote, ToolState } from "../finnhub/types.ts";
import { renderEmptyWatchlist, renderWatchlistSection } from "./watchlist.ts";

// ---------------------------------------------------------------------------
// Public type — ViewState
// ---------------------------------------------------------------------------

/**
 * Discriminated union of all possible render states for the main dashboard.
 *
 *  - `"loading"` — Initial state before the first quote sync completes.
 *  - `"error"`   — Finnhub is unreachable or returned an unexpected error.
 *  - `"empty"`   — The user's watchlist contains no items.
 *  - `"ready"`   — At least one quote has been successfully fetched.
 */
export type ViewState = "loading" | "error" | "empty" | "ready";

// ---------------------------------------------------------------------------
// Private constants — colour palette (mirrors watchlist.ts for visual consistency)
// ---------------------------------------------------------------------------

/** Primary accent (financial teal). */
const ACCENT = "#00897b";

/** Positive move colour (green). */
const COLOR_POSITIVE = "#2e7d32";

/** Negative move colour (red). */
const COLOR_NEGATIVE = "#c62828";

/** Neutral / zero-change colour (grey). */
const COLOR_NEUTRAL = "#555";

/** Background tint for positive-change badges. */
const BG_POSITIVE = "rgba(46, 125, 50, 0.10)";

/** Background tint for negative-change badges. */
const BG_NEGATIVE = "rgba(198, 40, 40, 0.10)";

/** Skeleton shimmer base colour (light grey). */
const SKELETON_BG = "#e8e8e8";

// ---------------------------------------------------------------------------
// Private helpers — number formatting
// ---------------------------------------------------------------------------

/**
 * Formats a numeric price as a USD string with two decimal places.
 *
 * @param value - The price to format.
 * @returns A string like `"$182.45"`.
 *
 * @example
 * formatPrice(182.45); // "$182.45"
 */
function formatPrice(value: number): string {
  return `$${value.toFixed(2)}`;
}

/**
 * Formats a signed percentage change with a leading `+` or typographic `−`
 * and two decimal places.
 *
 * @param value - The percentage change (e.g. `2.35` for +2.35 %).
 * @returns A string like `"+2.35%"` or `"−1.07%"`.
 *
 * @example
 * formatChange(2.35);   // "+2.35%"
 * formatChange(-1.07);  // "−1.07%"
 */
function formatChange(value: number): string {
  const sign = value >= 0 ? "+" : "\u2212";
  return `${sign}${Math.abs(value).toFixed(2)}%`;
}

/**
 * Returns the foreground CSS colour for a change percentage value.
 *
 * @param value - The percentage change.
 * @returns A CSS colour string: green for positive, red for negative, grey for zero.
 */
function changeColor(value: number): string {
  if (value > 0) return COLOR_POSITIVE;
  if (value < 0) return COLOR_NEGATIVE;
  return COLOR_NEUTRAL;
}

/**
 * Returns the background CSS colour for a change-badge based on sign.
 *
 * @param value - The percentage change.
 * @returns A CSS colour string suitable for `background`.
 */
function changeBg(value: number): string {
  if (value > 0) return BG_POSITIVE;
  if (value < 0) return BG_NEGATIVE;
  return "rgba(0,0,0,0.05)";
}

// ---------------------------------------------------------------------------
// Private helpers — index summary row
// ---------------------------------------------------------------------------

/**
 * Renders a single compact index-summary pill for one index/ETF item.
 *
 * Each pill shows the symbol, current price, and percentage change badge in a
 * tightly spaced horizontal layout. Intended for the index-summary row at the
 * top of the ready-state dashboard.
 *
 * @param symbol      - The ticker symbol (e.g. `"SPY"`).
 * @param displayName - Short display label (e.g. `"S&P 500 (SPY)"`).
 * @param quote       - Live quote data for this symbol, or `null` for a
 *                      skeleton pill (missing from the quotes map).
 * @returns An HTML fragment string for one index pill.
 */
function renderIndexPill(
  symbol: string,
  displayName: string,
  quote: Quote | null,
): string {
  if (quote === null) {
    // Skeleton pill — symbol visible but price obscured.
    return `<div style="
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 10px 14px;
      background: rgba(0, 137, 123, 0.04);
      border: 1px solid ${ACCENT}33;
      border-radius: 10px;
      min-width: 100px;
      flex: 1;
    ">
      <div style="
        font-size: 0.8rem;
        font-weight: 700;
        color: #1a1a1a;
        letter-spacing: 0.02em;
      ">${symbol}</div>
      <div style="
        font-size: 0.72rem;
        color: #aaa;
        margin-bottom: 2px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      ">${displayName}</div>
      <div style="height: 18px; width: 80px; border-radius: 4px; background: ${SKELETON_BG};"></div>
    </div>`;
  }

  const pct = quote.changePercent;
  const pctColor = changeColor(pct);
  const pctBg = changeBg(pct);

  return `<div style="
    display: flex;
    flex-direction: column;
    gap: 4px;
    padding: 10px 14px;
    background: rgba(0, 137, 123, 0.04);
    border: 1px solid ${ACCENT}33;
    border-radius: 10px;
    min-width: 100px;
    flex: 1;
  ">
    <div style="
      font-size: 0.8rem;
      font-weight: 700;
      color: #1a1a1a;
      letter-spacing: 0.02em;
    ">${symbol}</div>
    <div style="
      font-size: 0.72rem;
      color: #777;
      margin-bottom: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    ">${displayName}</div>
    <div style="display: flex; align-items: baseline; gap: 6px; flex-wrap: wrap;">
      <span style="
        font-size: 0.95rem;
        font-weight: 700;
        color: #111;
        font-variant-numeric: tabular-nums;
        letter-spacing: -0.01em;
      ">${formatPrice(quote.price)}</span>
      <span style="
        font-size: 0.75rem;
        font-weight: 600;
        color: ${pctColor};
        background: ${pctBg};
        padding: 1px 6px;
        border-radius: 20px;
        font-variant-numeric: tabular-nums;
      ">${formatChange(pct)}</span>
    </div>
  </div>`;
}

/**
 * Renders the horizontal index-summary row shown at the top of the ready-state
 * dashboard.
 *
 * Iterates over all watchlist items where `isIndex === true` and renders a
 * compact pill for each. If a symbol is missing from the quotes map it renders
 * a skeleton pill rather than showing zeroes.
 *
 * If there are no index items in the watchlist, returns an empty string so the
 * caller omits the section entirely.
 *
 * @param state  - Current tool state (provides the watchlist).
 * @param quotes - Live quote data keyed by symbol. Pass the same map used for
 *                 the full watchlist section.
 * @returns An HTML fragment string for the index summary row, or `""` if there
 *          are no index items.
 */
function renderIndexSummaryRow(
  state: ToolState,
  quotes: Map<string, Quote>,
): string {
  const indexItems = state.watchlist.filter((item) => item.isIndex);
  if (indexItems.length === 0) {
    return "";
  }

  const pills = indexItems
    .map((item) => {
      const quote = quotes.get(item.symbol) ?? null;
      return renderIndexPill(item.symbol, item.name, quote);
    })
    .join("\n");

  return `<div style="margin-bottom: 18px;">
    <div style="
      font-size: 0.75rem;
      font-weight: 600;
      color: #333;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      margin-bottom: 8px;
    ">Market Overview</div>
    <div style="display: flex; gap: 8px; flex-wrap: wrap;">
      ${pills}
    </div>
  </div>`;
}

// ---------------------------------------------------------------------------
// Private helpers — active alerts badge
// ---------------------------------------------------------------------------

/**
 * Renders a small informational banner showing the count of active price alerts.
 *
 * Returns an empty string when there are no active alerts so the caller omits
 * the section entirely.
 *
 * @param state - Current tool state (provides the price alerts array).
 * @returns An HTML fragment string for the alerts count row, or `""` if none
 *          are active.
 */
function renderAlertsCountBadge(state: ToolState): string {
  const activeCount = state.priceAlerts.filter((a) => a.active).length;
  if (activeCount === 0) {
    return "";
  }

  const label = activeCount === 1
    ? "1 active price alert"
    : `${activeCount} active price alerts`;

  return `<div style="
    margin-top: 16px;
    padding: 10px 14px;
    border-radius: 8px;
    border: 1px solid ${ACCENT}44;
    background: rgba(0, 137, 123, 0.04);
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 0.82rem;
    color: #444;
  ">
    <span style="
      font-size: 0.9rem;
      line-height: 1;
    ">🔔</span>
    <span>
      <strong style="color: ${ACCENT};">${label}</strong>
      — ask Chalie &ldquo;show my price alerts&rdquo; to review them.
    </span>
  </div>`;
}

// ---------------------------------------------------------------------------
// Private helpers — suggested prompts section
// ---------------------------------------------------------------------------

/**
 * Renders the suggested prompts section shown in the empty-watchlist state.
 *
 * All suggested prompts are stocks-only — no crypto symbols — to avoid
 * confusing the market-hours logic with 24/7 assets (crypto is a v2 feature).
 *
 * @returns An HTML fragment string containing a list of example queries.
 */
function renderSuggestedPrompts(): string {
  const prompts: string[] = [
    "How is the S&P 500 doing today?",
    "Add Tesla to my watchlist",
    "Set an alert if AAPL drops below $170",
  ];

  const items = prompts
    .map(
      (p) =>
        `<li style="
        padding: 7px 0;
        border-bottom: 1px solid rgba(0,0,0,0.06);
        font-size: 0.85rem;
        color: #444;
        font-style: italic;
      ">&ldquo;${p}&rdquo;</li>`,
    )
    .join("\n");

  return `<div style="
    margin-top: 20px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  ">
    <div style="
      font-size: 0.75rem;
      font-weight: 600;
      color: #888;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      margin-bottom: 8px;
    ">Try asking</div>
    <ul style="
      list-style: none;
      margin: 0;
      padding: 0;
      border-top: 1px solid rgba(0,0,0,0.06);
    ">
      ${items}
    </ul>
  </div>`;
}

// ---------------------------------------------------------------------------
// Private helpers — per-state renderers
// ---------------------------------------------------------------------------

/**
 * Renders the loading-state dashboard fragment.
 *
 * Shows a "Fetching market data…" status line followed by skeleton placeholder
 * cards for each item in the watchlist. The skeleton cards show the symbol and
 * name but replace all numeric values with muted grey rectangle blocks,
 * giving the user a sense of forthcoming content without showing zeroes.
 *
 * @param state - Current tool state (provides the watchlist for skeleton cards).
 * @returns A non-empty HTML fragment string.
 */
function renderLoadingView(state: ToolState): string {
  const skeletonSection = renderWatchlistSection(state.watchlist, null);

  return `<div style="
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  ">

    <!-- Loading status banner -->
    <div style="
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      margin-bottom: 16px;
      border-radius: 8px;
      background: rgba(0, 137, 123, 0.06);
      border: 1px solid ${ACCENT}33;
      font-size: 0.83rem;
      color: #555;
    ">
      <!-- Pulsing dot (static representation — animation requires inline style only) -->
      <span style="
        display: inline-block;
        width: 9px;
        height: 9px;
        border-radius: 50%;
        background: ${ACCENT};
        opacity: 0.7;
        flex-shrink: 0;
      "></span>
      <span>Fetching market data&hellip;</span>
    </div>

    <!-- Skeleton watchlist cards -->
    ${skeletonSection}

  </div>`;
}

/**
 * Renders the error-state dashboard fragment.
 *
 * Displays a prominent banner explaining that Finnhub is unreachable, the last
 * time data was successfully fetched (or "never" on first run), the retry
 * interval in minutes derived from the current settings, and a gear-icon
 * action link so the user can check their API key configuration.
 *
 * @param state - Current tool state (provides `lastSyncAt` and settings for
 *                the retry interval).
 * @returns A non-empty HTML fragment string.
 */
function renderErrorView(state: ToolState): string {
  const lastUpdated = state.lastSyncAt
    ? new Date(state.lastSyncAt).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    })
    : "never";

  const retryMinutes = Math.round(
    state.settings.syncIntervalMarketClosed / 60_000,
  );
  const retryLabel = retryMinutes === 1
    ? "1 minute"
    : `${retryMinutes} minutes`;

  return `<div style="
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  ">

    <!-- Error banner -->
    <div style="
      padding: 14px 16px;
      border-radius: 10px;
      border: 1px solid rgba(198, 40, 40, 0.35);
      background: rgba(198, 40, 40, 0.05);
      display: flex;
      align-items: flex-start;
      gap: 12px;
    ">

      <!-- Warning icon -->
      <span style="
        font-size: 1.2rem;
        line-height: 1;
        flex-shrink: 0;
        margin-top: 1px;
      ">⚠️</span>

      <div style="flex: 1; min-width: 0;">
        <div style="
          font-size: 0.9rem;
          font-weight: 600;
          color: #b71c1c;
          margin-bottom: 4px;
        ">Unable to reach Finnhub</div>
        <div style="
          font-size: 0.82rem;
          color: #555;
          line-height: 1.55;
        ">
          Last updated: <strong>${lastUpdated}</strong>.
          Retrying in <strong>${retryLabel}</strong>.
        </div>
      </div>

      <!-- Gear icon — data-action wired by the Chalie runtime -->
      <div
        data-action="open-settings"
        title="Check API key settings"
        style="
          flex-shrink: 0;
          width: 30px;
          height: 30px;
          border-radius: 8px;
          border: 1px solid rgba(0,0,0,0.12);
          background: rgba(0,0,0,0.04);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 1rem;
          color: #888;
          cursor: pointer;
        "
      >&#9881;</div>

    </div>

    <!-- Hint about API key -->
    <div style="
      margin-top: 10px;
      font-size: 0.78rem;
      color: #888;
      text-align: center;
    ">
      Click &#9881; to verify your Finnhub API key, or ask Chalie
      &ldquo;check my API key&rdquo;.
    </div>

  </div>`;
}

/**
 * Renders the empty-state dashboard fragment.
 *
 * Delegates to {@link renderEmptyWatchlist} for the main empty-watchlist card,
 * then appends the {@link renderSuggestedPrompts} section with stocks-only
 * example queries. No crypto prompts are included (crypto is a v2 feature).
 *
 * @returns A non-empty HTML fragment string.
 */
function renderEmptyView(): string {
  return `<div style="
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  ">
    ${renderEmptyWatchlist()}
    ${renderSuggestedPrompts()}
  </div>`;
}

/**
 * Renders the fully-populated ready-state dashboard fragment.
 *
 * Layout (top to bottom):
 * 1. **Index summary row** — compact pills for all `isIndex: true` watchlist
 *    items (SPY, QQQ, DIA by default), showing price and daily change %.
 *    Omitted if the watchlist contains no index items.
 * 2. **Watchlist section** — full cards for all non-index items, delegating
 *    to {@link renderWatchlistSection}. Omitted if there are no non-index items.
 * 3. **Active alerts badge** — a single-line summary of how many price alerts
 *    are currently active. Omitted when there are none.
 *
 * @param state  - Current tool state (watchlist, price alerts).
 * @param quotes - Live quote data keyed by symbol. Must be a populated `Map`
 *                 (not `null`) in the ready state.
 * @returns A non-empty HTML fragment string.
 */
function renderReadyView(state: ToolState, quotes: Map<string, Quote>): string {
  const indexRow = renderIndexSummaryRow(state, quotes);

  const nonIndexItems = state.watchlist.filter((item) => !item.isIndex);
  const watchlistSection = nonIndexItems.length > 0
    ? renderWatchlistSection(nonIndexItems, quotes)
    : "";

  const alertsBadge = renderAlertsCountBadge(state);

  const lastSyncLine = state.lastSyncAt
    ? `<div style="
        font-size: 0.72rem;
        color: #aaa;
        text-align: right;
        margin-bottom: 12px;
        font-variant-numeric: tabular-nums;
      ">Updated ${
      new Date(state.lastSyncAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    }</div>`
    : "";

  return `<div style="
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  ">
    ${lastSyncLine}
    ${indexRow}
    ${watchlistSection}
    ${alertsBadge}
  </div>`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Renders the main stock-market dashboard HTML fragment for the given
 * {@link ViewState}.
 *
 * This is the single entry-point used by the daemon's display loop. Pass the
 * current persisted state, the latest quotes map (or `null` while loading),
 * and the view state that describes which variant to render.
 *
 * All returned HTML conforms to the Chalie tool HTML contract:
 *  - Inline CSS only — no `<style>` blocks or external stylesheets.
 *  - No `<script>` tags, event handlers, or `javascript:` URIs.
 *  - Fragment only — no `<html>`, `<head>`, or `<body>` wrappers.
 *  - Interactive controls use `data-*` attributes only.
 *
 * @param state     - The current persisted tool state. Always required; used
 *                    across all view states for watchlist, settings, and alerts.
 * @param quotes    - Live quote data keyed by symbol, or `null` when no data
 *                    has been fetched yet. Only meaningful in the `"ready"` and
 *                    `"loading"` states; ignored in `"error"` and `"empty"`.
 * @param viewState - The dashboard variant to render.
 * @returns A non-empty HTML fragment string.
 *
 * @example
 * // Loading state — no data yet
 * const html = renderMainView(state, null, "loading");
 *
 * @example
 * // Ready state — quotes available
 * const quotes = new Map([["SPY", spyQuote], ["AAPL", aaplQuote]]);
 * const html = renderMainView(state, quotes, "ready");
 *
 * @example
 * // Error state — Finnhub unreachable
 * const html = renderMainView(state, null, "error");
 *
 * @example
 * // Empty state — user removed all watchlist items
 * const html = renderMainView(state, null, "empty");
 */
export function renderMainView(
  state: ToolState,
  quotes: Map<string, Quote> | null,
  viewState: ViewState,
): string {
  switch (viewState) {
    case "loading":
      return renderLoadingView(state);

    case "error":
      return renderErrorView(state);

    case "empty":
      return renderEmptyView();

    case "ready": {
      // In the "ready" state the caller must provide a populated quotes map.
      // Defensively fall back to loading view if null is passed anyway.
      if (quotes === null) {
        return renderLoadingView(state);
      }
      return renderReadyView(state, quotes);
    }
  }
}
