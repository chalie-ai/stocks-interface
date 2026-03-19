/**
 * @file src/ui/watchlist.ts
 * @description Watchlist HTML rendering and default data for the
 * stocks-interface tool.
 *
 * Provides:
 *  - {@link DEFAULT_WATCHLIST} — the three index-proxy ETFs shown on first run.
 *  - {@link renderWatchlistSection} — renders populated cards or skeleton/loading
 *    placeholders depending on whether live quote data is available.
 *  - {@link renderEmptyWatchlist} — renders an empty-state prompt when the user
 *    has removed all watchlist entries.
 *
 * HTML contract (09-TOOLS.md):
 *  - Inline CSS only — no `<style>` blocks, no external stylesheets.
 *  - No JavaScript — no `<script>` tags, no event handlers, no `javascript:` URIs.
 *  - Fragment only — no `<html>`, `<head>`, or `<body>` tags.
 *  - Interactive controls use `data-*` attributes only; wiring is handled by
 *    the Chalie tool runtime, not by inline handlers.
 *  - Drag-to-reorder is intentionally absent (deferred to v2).
 *
 * @module stocks-interface/ui/watchlist
 */

import type { WatchlistItem, Quote } from "../finnhub/types.ts";

// ---------------------------------------------------------------------------
// Re-export types consumed by callers (avoids forcing them to import types.ts)
// ---------------------------------------------------------------------------

export type { WatchlistItem };

// ---------------------------------------------------------------------------
// Private constants — colour palette
// ---------------------------------------------------------------------------

/** Primary accent (financial teal). */
const ACCENT = "#00897b";

/** Positive move colour (green). */
const COLOR_POSITIVE = "#2e7d32";

/** Background tint for positive-change cells. */
const BG_POSITIVE = "rgba(46, 125, 50, 0.08)";

/** Negative move colour (red). */
const COLOR_NEGATIVE = "#c62828";

/** Background tint for negative-change cells. */
const BG_NEGATIVE = "rgba(198, 40, 40, 0.08)";

/** Neutral / zero-change colour. */
const COLOR_NEUTRAL = "#555";

/** Card border colour for regular stock / ETF items. */
const CARD_BORDER_STOCK = "rgba(0, 0, 0, 0.10)";

/** Card border colour for index / index-proxy items (teal tint). */
const CARD_BORDER_INDEX = `${ACCENT}44`;

/** Card background for index / index-proxy items. */
const CARD_BG_INDEX = "rgba(0, 137, 123, 0.05)";

/** Label colour for secondary text (High / Low / Open labels). */
const LABEL_COLOR = "#888";

/** Skeleton shimmer base colour. */
const SKELETON_BG = "#e8e8e8";

// ---------------------------------------------------------------------------
// Public data — default watchlist
// ---------------------------------------------------------------------------

/**
 * The three index-proxy ETFs pre-loaded on first run.
 *
 * Each entry uses an ETF that closely tracks a major US index, because the
 * exact Finnhub-native index identifiers are unavailable on the free tier:
 *
 * | ETF  | Tracks              |
 * |------|---------------------|
 * | SPY  | S&P 500             |
 * | QQQ  | NASDAQ 100          |
 * | DIA  | Dow Jones (DJIA)    |
 *
 * All three have `isIndex: true` so alert thresholds use the (lower)
 * {@link Settings.notableThresholdIndex} value rather than the stock threshold.
 *
 * `addedAt` is an empty string because these items are not user-added; they
 * are present before timestamp tracking is meaningful.
 */
export const DEFAULT_WATCHLIST: WatchlistItem[] = [
  {
    symbol: "SPY",
    name: "S&P 500 (SPY)",
    exchange: "US",
    type: "etf",
    addedAt: "",
    isIndex: true,
  },
  {
    symbol: "QQQ",
    name: "NASDAQ 100 (QQQ)",
    exchange: "US",
    type: "etf",
    addedAt: "",
    isIndex: true,
  },
  {
    symbol: "DIA",
    name: "Dow Jones (DIA)",
    exchange: "US",
    type: "etf",
    addedAt: "",
    isIndex: true,
  },
];

// ---------------------------------------------------------------------------
// Private helpers — number formatting
// ---------------------------------------------------------------------------

/**
 * Formats a price value as a USD string with two decimal places.
 *
 * @param value - The numeric price to format.
 * @returns A string like `"$182.45"`.
 *
 * @example
 * formatPrice(182.45); // "$182.45"
 */
function formatPrice(value: number): string {
  return `$${value.toFixed(2)}`;
}

/**
 * Formats a signed percentage change with a leading `+` or `−` sign and two
 * decimal places.
 *
 * @param value - The percentage change (e.g. `2.35` for +2.35 %).
 * @returns A string like `"+2.35%"` or `"−1.07%"`.
 *
 * @example
 * formatChange(2.35);   // "+2.35%"
 * formatChange(-1.07);  // "−1.07%"
 * formatChange(0);      // "+0.00%"
 */
function formatChange(value: number): string {
  const sign = value >= 0 ? "+" : "\u2212"; // Unicode minus for typographic consistency
  return `${sign}${Math.abs(value).toFixed(2)}%`;
}

/**
 * Selects the foreground colour for a change-percent value.
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
 * Selects the background tint for a change badge based on the sign of the
 * percentage change.
 *
 * @param value - The percentage change.
 * @returns A CSS colour string suitable for `background`.
 */
function changeBg(value: number): string {
  if (value > 0) return BG_POSITIVE;
  if (value < 0) return BG_NEGATIVE;
  return "rgba(0,0,0,0.04)";
}

// ---------------------------------------------------------------------------
// Private helpers — HTML fragments
// ---------------------------------------------------------------------------

/**
 * Renders a single watchlist card for a symbol that has live quote data.
 *
 * The card shows:
 * - Symbol (bold) and human-readable name (muted).
 * - Current price (large) alongside the percentage change badge.
 * - Day high, low, and open in a secondary row.
 * - A remove button (`data-action="remove-watchlist-item"` +
 *   `data-symbol="<SYMBOL>"`) — no JS handler, wired by the Chalie runtime.
 *
 * Index items (`item.isIndex === true`) receive a teal-tinted border and
 * background to visually distinguish them from individual stocks.
 *
 * @param item  - The watchlist entry being rendered.
 * @param quote - Live quote data for this symbol.
 * @returns An HTML fragment string for one watchlist card.
 */
function renderQuoteCard(item: WatchlistItem, quote: Quote): string {
  const border = item.isIndex ? CARD_BORDER_INDEX : CARD_BORDER_STOCK;
  const bg = item.isIndex ? CARD_BG_INDEX : "#fff";
  const displayName = quote.name ?? item.name;
  const pct = quote.changePercent;
  const pctColor = changeColor(pct);
  const pctBg = changeBg(pct);
  const indexBadge = item.isIndex
    ? `<span style="
        font-size: 0.65rem;
        font-weight: 600;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        color: ${ACCENT};
        background: ${ACCENT}1a;
        padding: 2px 6px;
        border-radius: 4px;
        margin-left: 6px;
        vertical-align: middle;
      ">INDEX</span>`
    : "";

  return `<div style="
    background: ${bg};
    border: 1px solid ${border};
    border-radius: 10px;
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    position: relative;
  ">

    <!-- Header row: symbol + name + remove button -->
    <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 8px;">
      <div style="min-width: 0; flex: 1;">
        <span style="
          font-size: 1rem;
          font-weight: 700;
          color: #1a1a1a;
          letter-spacing: 0.01em;
        ">${item.symbol}</span>${indexBadge}
        <div style="
          font-size: 0.775rem;
          color: #666;
          margin-top: 1px;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        ">${displayName}</div>
      </div>
      <div
        data-action="remove-watchlist-item"
        data-symbol="${item.symbol}"
        title="Remove ${item.symbol} from watchlist"
        style="
          flex-shrink: 0;
          width: 24px;
          height: 24px;
          border-radius: 6px;
          border: 1px solid rgba(0,0,0,0.12);
          background: rgba(0,0,0,0.04);
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 0.75rem;
          color: #888;
          cursor: pointer;
        ">&times;</div>
    </div>

    <!-- Price row: current price + change badge -->
    <div style="display: flex; align-items: baseline; gap: 10px;">
      <span style="
        font-size: 1.35rem;
        font-weight: 700;
        color: #111;
        font-variant-numeric: tabular-nums;
        letter-spacing: -0.01em;
      ">${formatPrice(quote.price)}</span>
      <span style="
        font-size: 0.85rem;
        font-weight: 600;
        color: ${pctColor};
        background: ${pctBg};
        padding: 2px 8px;
        border-radius: 20px;
        font-variant-numeric: tabular-nums;
      ">${formatChange(pct)}</span>
    </div>

    <!-- Secondary row: High / Low / Open -->
    <div style="
      display: flex;
      gap: 16px;
      font-size: 0.775rem;
      color: ${LABEL_COLOR};
      font-variant-numeric: tabular-nums;
    ">
      <span>
        <span style="font-weight: 600; color: #444;">H</span>
        &thinsp;${formatPrice(quote.high)}
      </span>
      <span>
        <span style="font-weight: 600; color: #444;">L</span>
        &thinsp;${formatPrice(quote.low)}
      </span>
      <span>
        <span style="font-weight: 600; color: #444;">O</span>
        &thinsp;${formatPrice(quote.open)}
      </span>
    </div>

  </div>`;
}

/**
 * Renders a single skeleton placeholder card used during the initial data
 * load (when quotes have not yet been fetched).
 *
 * Uses muted rectangular blocks to mirror the populated card's layout,
 * giving the user a sense of the forthcoming content without showing stale
 * or zero values. Implemented in CSS only — no animations.
 *
 * @param item - The watchlist entry whose symbol/name are shown even before
 *   live data arrives, so the skeleton is identifiable.
 * @returns An HTML fragment string for one skeleton watchlist card.
 */
function renderSkeletonCard(item: WatchlistItem): string {
  const border = item.isIndex ? CARD_BORDER_INDEX : CARD_BORDER_STOCK;
  const bg = item.isIndex ? CARD_BG_INDEX : "#fff";

  return `<div style="
    background: ${bg};
    border: 1px solid ${border};
    border-radius: 10px;
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  ">

    <!-- Symbol and name (visible even while loading) -->
    <div style="display: flex; justify-content: space-between; align-items: center;">
      <div>
        <div style="
          font-size: 1rem;
          font-weight: 700;
          color: #1a1a1a;
          letter-spacing: 0.01em;
        ">${item.symbol}</div>
        <div style="
          font-size: 0.775rem;
          color: #999;
          margin-top: 2px;
        ">${item.name}</div>
      </div>
      <!-- Skeleton remove button placeholder -->
      <div style="
        width: 24px;
        height: 24px;
        border-radius: 6px;
        background: ${SKELETON_BG};
      "></div>
    </div>

    <!-- Price skeleton block -->
    <div style="
      height: 28px;
      width: 110px;
      border-radius: 6px;
      background: ${SKELETON_BG};
    "></div>

    <!-- Secondary stats skeleton row -->
    <div style="display: flex; gap: 12px;">
      <div style="height: 14px; width: 60px; border-radius: 4px; background: ${SKELETON_BG};"></div>
      <div style="height: 14px; width: 60px; border-radius: 4px; background: ${SKELETON_BG};"></div>
      <div style="height: 14px; width: 60px; border-radius: 4px; background: ${SKELETON_BG};"></div>
    </div>

  </div>`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Renders the watchlist section HTML fragment.
 *
 * When `quotes` is a populated `Map`, each watchlist item is rendered as a
 * live data card showing the current price, percentage change, day high/low,
 * and a remove button. Index items (`isIndex: true`) receive a distinct teal
 * tint to separate them visually from individual stocks.
 *
 * When `quotes` is `null` (the initial loading state, before the first sync
 * cycle completes), each item is rendered as a skeleton placeholder card
 * showing the symbol and name but substituting all numeric fields with grey
 * rectangle blocks.
 *
 * If a symbol is present in `items` but absent from `quotes` (partial data),
 * that item falls back to a skeleton card rather than showing zeroes.
 *
 * @param items  - The watchlist entries to render, in display order.
 * @param quotes - Live quote data keyed by symbol, or `null` while loading.
 * @returns A non-empty HTML fragment string conforming to the Chalie tool
 *   HTML contract. Returns {@link renderEmptyWatchlist} output when `items`
 *   is empty.
 *
 * @example
 * // Loading state — no data yet
 * const html = renderWatchlistSection(DEFAULT_WATCHLIST, null);
 *
 * @example
 * // Populated state
 * const quotes = new Map([["SPY", spyQuote], ["QQQ", qqqQuote], ["DIA", diaQuote]]);
 * const html = renderWatchlistSection(DEFAULT_WATCHLIST, quotes);
 */
export function renderWatchlistSection(
  items: WatchlistItem[],
  quotes: Map<string, Quote> | null
): string {
  if (items.length === 0) {
    return renderEmptyWatchlist();
  }

  const cards = items.map((item) => {
    if (quotes === null) {
      return renderSkeletonCard(item);
    }
    const quote = quotes.get(item.symbol);
    if (quote === undefined) {
      // Symbol present in watchlist but missing from the quotes map — use skeleton.
      return renderSkeletonCard(item);
    }
    return renderQuoteCard(item, quote);
  });

  const loadingBanner =
    quotes === null
      ? `<div style="
          font-size: 0.8rem;
          color: #888;
          margin-bottom: 12px;
          display: flex;
          align-items: center;
          gap: 6px;
        ">
          <span style="
            display: inline-block;
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: ${ACCENT};
            opacity: 0.6;
          "></span>
          Fetching market data…
        </div>`
      : "";

  return `<div style="
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  ">
    <div style="
      font-size: 0.75rem;
      font-weight: 600;
      color: #333;
      text-transform: uppercase;
      letter-spacing: 0.07em;
      margin-bottom: 10px;
    ">Watchlist</div>

    ${loadingBanner}

    <div style="
      display: flex;
      flex-direction: column;
      gap: 10px;
    ">
      ${cards.join("\n")}
    </div>
  </div>`;
}

/**
 * Renders the empty-state HTML fragment shown when the user's watchlist
 * contains no entries.
 *
 * Displays a friendly message and a call-to-action directing the user to
 * search for symbols via the chat interface.
 *
 * @returns A non-empty HTML fragment string conforming to the Chalie tool
 *   HTML contract.
 *
 * @example
 * const html = renderEmptyWatchlist();
 */
export function renderEmptyWatchlist(): string {
  return `<div style="
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    padding: 32px 24px;
    border-radius: 12px;
    border: 1.5px dashed rgba(0, 137, 123, 0.35);
    background: rgba(0, 137, 123, 0.03);
    text-align: center;
  ">
    <div style="font-size: 2.2rem; margin-bottom: 12px; line-height: 1;">📋</div>
    <div style="
      font-size: 0.975rem;
      font-weight: 600;
      color: #1a1a1a;
      margin-bottom: 8px;
    ">Your watchlist is empty</div>
    <div style="
      font-size: 0.85rem;
      color: #666;
      line-height: 1.65;
      max-width: 300px;
      margin: 0 auto;
    ">
      Search for stocks above to start tracking.
      Try asking Chalie to <em>&ldquo;add AAPL to my watchlist&rdquo;</em>.
    </div>
  </div>`;
}
