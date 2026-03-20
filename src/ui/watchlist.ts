/**
 * Watchlist rendering and default data for the Stocks Interface daemon
 * (block protocol).
 *
 * Provides:
 *  - {@link DEFAULT_WATCHLIST} — the three index-proxy ETFs shown on first run.
 *  - {@link renderWatchlistSection} — renders populated or skeleton cards.
 *  - {@link renderEmptyWatchlist} — renders the empty-state prompt.
 *
 * @module stocks-interface/ui/watchlist
 */

import type { Block } from "../../../_sdk/blocks.ts";
import {
  section, text, columns, keyvalue, badge, actions, button, loading, header,
} from "../../../_sdk/blocks.ts";
import type { Quote, WatchlistItem } from "../finnhub/types.ts";

// Re-export for callers
export type { WatchlistItem };

// ---------------------------------------------------------------------------
// Default watchlist
// ---------------------------------------------------------------------------

/**
 * Three index-proxy ETFs pre-loaded on first run.
 *
 * | ETF  | Tracks           |
 * |------|------------------|
 * | SPY  | S&P 500          |
 * | QQQ  | NASDAQ 100       |
 * | DIA  | Dow Jones (DJIA) |
 */
export const DEFAULT_WATCHLIST: WatchlistItem[] = [
  { symbol: "SPY", name: "S&P 500 (SPY)", exchange: "US", type: "etf", addedAt: "", isIndex: true },
  { symbol: "QQQ", name: "NASDAQ 100 (QQQ)", exchange: "US", type: "etf", addedAt: "", isIndex: true },
  { symbol: "DIA", name: "Dow Jones (DIA)", exchange: "US", type: "etf", addedAt: "", isIndex: true },
];

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatPrice(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatChange(value: number): string {
  const sign = value >= 0 ? "+" : "\u2212";
  return `${sign}${Math.abs(value).toFixed(2)}%`;
}

function changeVariant(value: number): "success" | "error" | "info" {
  if (value > 0) return "success";
  if (value < 0) return "error";
  return "info";
}

// ---------------------------------------------------------------------------
// Card renderers
// ---------------------------------------------------------------------------

/** Render a single watchlist card with live quote data. */
function renderQuoteCard(item: WatchlistItem, quote: Quote): Block {
  const displayName = quote.name ?? item.name;
  const pct = quote.changePercent;
  const symbolLabel = item.isIndex ? `**${item.symbol}** INDEX` : `**${item.symbol}**`;

  return section([
    columns(
      {
        width: "1fr",
        blocks: [
          text(symbolLabel, "markdown"),
          text(displayName, "plain"),
        ],
      },
      {
        width: "auto",
        blocks: [
          actions(
            button("\u00d7", {
              execute: "watchlist_remove",
              payload: { symbol: item.symbol },
              style: "secondary",
            }),
          ),
        ],
      },
    ),
    columns(
      { width: "auto", blocks: [text(`**${formatPrice(quote.price)}**`, "markdown")] },
      { width: "auto", blocks: [badge(formatChange(pct), changeVariant(pct))] },
    ),
    keyvalue([
      { key: "High", value: formatPrice(quote.high) },
      { key: "Low", value: formatPrice(quote.low) },
      { key: "Open", value: formatPrice(quote.open) },
    ]),
  ]);
}

/** Render a skeleton card for a symbol whose quote hasn't loaded yet. */
function renderSkeletonCard(item: WatchlistItem): Block {
  return section([
    text(`**${item.symbol}**`, "markdown"),
    text(item.name, "plain"),
    loading("Loading..."),
  ]);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render the watchlist section as blocks.
 *
 * When `quotes` is populated, each item renders as a live data card.
 * When `quotes` is `null` (initial load), each item renders as a skeleton.
 * Missing symbols fall back to skeleton cards.
 *
 * @param items  - Watchlist entries to render, in display order.
 * @param quotes - Live quote data keyed by symbol, or `null` while loading.
 * @returns Block array for the watchlist section.
 */
export function renderWatchlistSection(
  items: WatchlistItem[],
  quotes: Map<string, Quote> | null,
): Block[] {
  if (items.length === 0) return renderEmptyWatchlist();

  const cards = items.map((item) => {
    if (quotes === null) return renderSkeletonCard(item);
    const quote = quotes.get(item.symbol);
    if (!quote) return renderSkeletonCard(item);
    return renderQuoteCard(item, quote);
  });

  return [section(cards, "Watchlist")];
}

/**
 * Render the empty-watchlist prompt.
 *
 * @returns Block array for the empty state.
 */
export function renderEmptyWatchlist(): Block[] {
  return [
    section([
      header("Your watchlist is empty", 3),
      text(
        "Search for stocks above to start tracking. " +
        "Try asking Chalie to \"add AAPL to my watchlist\".",
        "plain",
      ),
    ]),
  ];
}
