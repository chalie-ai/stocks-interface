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
import type { WatchlistItem, Quote } from "../finnhub/types.js";
export type { WatchlistItem };
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
export declare const DEFAULT_WATCHLIST: WatchlistItem[];
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
export declare function renderWatchlistSection(items: WatchlistItem[], quotes: Map<string, Quote> | null): string;
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
export declare function renderEmptyWatchlist(): string;
//# sourceMappingURL=watchlist.d.ts.map