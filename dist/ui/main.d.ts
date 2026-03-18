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
import type { ToolState, Quote } from "../finnhub/types.js";
/**
 * Discriminated union of all possible render states for the main dashboard.
 *
 *  - `"loading"` — Initial state before the first quote sync completes.
 *  - `"error"`   — Finnhub is unreachable or returned an unexpected error.
 *  - `"empty"`   — The user's watchlist contains no items.
 *  - `"ready"`   — At least one quote has been successfully fetched.
 */
export type ViewState = "loading" | "error" | "empty" | "ready";
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
export declare function renderMainView(state: ToolState, quotes: Map<string, Quote> | null, viewState: ViewState): string;
//# sourceMappingURL=main.d.ts.map