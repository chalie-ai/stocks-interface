/**
 * @file src/capabilities/stock-news.ts
 * @description Capability handler that fetches and renders recent company news
 * for a single symbol.
 *
 * Invoked by the Chalie reasoning layer when the user asks for news about a
 * specific stock (e.g. "What's the latest news on Tesla?").
 *
 * ## Data sources
 * - **Company news** — `GET /company-news` via {@link FinnhubClient.news},
 *   fetching the trailing 7-day window. One API call per invocation (priority
 *   tier 4 — background, deferrable).
 *
 * ## Limit semantics
 * - Default limit: {@link DEFAULT_LIMIT} (5 articles)
 * - Maximum limit: {@link MAX_LIMIT} (10 articles)
 * - Caller-supplied `limit` values above {@link MAX_LIMIT} are silently capped.
 *
 * ## Date window
 * News is always fetched for the trailing 7 calendar days from the current UTC
 * date. This window is a fixed design choice that keeps the API request
 * consistent without requiring the caller to supply date parameters.
 *
 * @module stocks-interface/capabilities/stock-news
 */

import type { FinnhubClient } from "../finnhub/client.js";
import type { NewsItem, ToolState } from "../finnhub/types.js";
import type { CapabilityResult } from "./stock-quote.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Number of articles returned when the caller does not supply a `limit`.
 * A value of 5 balances informativeness with UI density.
 */
const DEFAULT_LIMIT = 5;

/**
 * Hard upper bound on the number of articles returned regardless of the
 * caller-supplied `limit`. Prevents excessively long HTML cards.
 */
const MAX_LIMIT = 10;

/**
 * Size of the trailing news window in milliseconds (7 days).
 * Passed as the date range to {@link FinnhubClient.news}.
 */
const NEWS_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Formats a Unix timestamp (seconds) as a short human-readable date string
 * using the `en-US` locale (e.g. `"Jan 15, 2026"`).
 *
 * @param timestamp - Unix timestamp in seconds (as returned by Finnhub).
 * @returns Localised date string such as `"Jan 15, 2026"`.
 */
function formatDate(timestamp: number): string {
  return new Date(timestamp * 1_000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Escapes a string for safe interpolation into HTML attribute values and text
 * nodes, preventing XSS from server-sourced headlines, source names, or URLs.
 *
 * @param str - Raw string to escape.
 * @returns HTML-safe string with `&`, `<`, `>`, `"`, and `'` entities encoded.
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Renders a single news article as an HTML list item `<div>`.
 *
 * The headline is wrapped in an anchor tag pointing to the article URL.
 * Source name and formatted publication date appear as secondary metadata.
 * A bottom border is rendered on all items except the last one.
 *
 * @param article - The {@link NewsItem} to render.
 * @param isLast  - `true` when this is the last item in the list; suppresses
 *   the bottom border separator.
 * @returns An HTML `<div>…</div>` string representing one news item.
 */
function renderNewsItem(article: NewsItem, isLast: boolean): string {
  const borderStyle = isLast ? "" : "border-bottom:1px solid #f3f4f6;";
  return `
<div style="padding:10px 0;${borderStyle}">
  <a href="${escapeHtml(article.url)}"
     target="_blank"
     rel="noopener noreferrer"
     style="font-size:14px;font-weight:600;color:#1d4ed8;text-decoration:none;
            line-height:1.4;display:block">
    ${escapeHtml(article.headline)}
  </a>
  <div style="margin-top:4px;display:flex;gap:8px;align-items:center">
    <span style="font-size:12px;color:#6b7280">${escapeHtml(article.source)}</span>
    <span style="font-size:12px;color:#d1d5db">&bull;</span>
    <span style="font-size:12px;color:#9ca3af">${formatDate(article.datetime)}</span>
  </div>
</div>`.trim();
}

// ---------------------------------------------------------------------------
// Exported handler
// ---------------------------------------------------------------------------

/**
 * Fetches recent company news for a single symbol and returns a formatted
 * news card alongside a plain-text summary.
 *
 * ### HTML card contents
 * - Card header with symbol name and article count
 * - Up to {@link MAX_LIMIT} news items, each showing:
 *   - Clickable headline (links to the full article)
 *   - Source name
 *   - Formatted publication date
 *
 * ### Empty-result handling
 * When Finnhub returns zero articles for the trailing 7-day window, a
 * user-friendly "No recent news found" message is returned without setting
 * the `error` field (empty results are expected for some symbols).
 *
 * ### Error handling
 * On any Finnhub error the function resolves (not rejects) with a
 * {@link CapabilityResult} that has `error` set and a user-facing HTML message.
 *
 * @param params         - Handler parameters.
 * @param params.symbol  - Ticker symbol to look up (case-insensitive;
 *   normalised to upper-case internally).
 * @param params.limit   - Maximum number of articles to return. Defaults to
 *   {@link DEFAULT_LIMIT} (5). Capped at {@link MAX_LIMIT} (10).
 * @param client         - Configured {@link FinnhubClient} instance.
 * @param _state         - Current {@link ToolState}. Accepted for interface
 *   consistency with other capability handlers; not used by this handler.
 * @returns A resolved {@link CapabilityResult} — never rejects.
 *
 * @example
 * ```ts
 * const result = await handleStockNews({ symbol: "TSLA", limit: 5 }, client, state);
 * console.log(result.text);
 * // "Recent news for TSLA (5 articles): "Tesla Earnings Beat..." (Reuters, Jan 15, 2026) | ..."
 * ```
 */
export async function handleStockNews(
  params: { symbol: string; limit?: number },
  client: FinnhubClient,
  _state: ToolState,
): Promise<CapabilityResult> {
  const symbol = params.symbol.toUpperCase().trim();
  const limit = Math.min(params.limit ?? DEFAULT_LIMIT, MAX_LIMIT);

  // ── Build date-range strings for the trailing 7-day window ───────────────
  const nowMs = Date.now();
  const toDate = new Date(nowMs).toISOString().slice(0, 10);
  const fromDate = new Date(nowMs - NEWS_WINDOW_MS).toISOString().slice(0, 10);

  // ── Fetch news ────────────────────────────────────────────────────────────
  let articles: NewsItem[];
  try {
    articles = await client.news(symbol, fromDate, toDate);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const html = `
<div style="font-family:system-ui,sans-serif;background:#fff;border:1px solid #fecaca;
    border-radius:8px;padding:16px;max-width:520px">
  <p style="margin:0;color:#dc2626;font-size:14px">
    <strong>Error fetching news for ${escapeHtml(symbol)}:</strong> ${escapeHtml(msg)}
  </p>
</div>`.trim();
    return {
      text: `Error fetching news for ${symbol}: ${msg}`,
      html,
      error: msg,
    };
  }

  // ── Slice to requested limit ──────────────────────────────────────────────
  const items = articles.slice(0, limit);

  // ── Handle empty result ───────────────────────────────────────────────────
  if (items.length === 0) {
    const msg = `No recent news found for ${symbol} in the last 7 days.`;
    const html = `
<div style="font-family:system-ui,sans-serif;background:#fff;border:1px solid #e5e7eb;
    border-radius:8px;padding:16px;max-width:520px">
  <p style="margin:0;color:#6b7280;font-size:14px">${escapeHtml(msg)}</p>
</div>`.trim();
    return { text: msg, html };
  }

  // ── Plain-text summary ────────────────────────────────────────────────────
  const textParts = items.map(
    (a) => `"${a.headline}" (${a.source}, ${formatDate(a.datetime)})`,
  );
  const text =
    `Recent news for ${symbol} (${items.length} article` +
    `${items.length !== 1 ? "s" : ""}): ` +
    textParts.join(" | ");

  // ── HTML card ─────────────────────────────────────────────────────────────
  const newsItemsHtml = items
    .map((article, i) => renderNewsItem(article, i === items.length - 1))
    .join("\n");

  const articleCountLabel =
    `${items.length} article${items.length !== 1 ? "s" : ""}`;

  const html = `
<div style="font-family:system-ui,sans-serif;background:#fff;border:1px solid #e5e7eb;
    border-radius:8px;padding:16px;max-width:520px;
    box-shadow:0 1px 3px rgba(0,0,0,0.08)">

  <!-- Card header -->
  <div style="display:flex;justify-content:space-between;align-items:center;
      margin-bottom:8px">
    <span style="font-size:15px;font-weight:700;color:#111827">
      Recent News &mdash; ${escapeHtml(symbol)}
    </span>
    <span style="font-size:12px;color:#9ca3af">${escapeHtml(articleCountLabel)}</span>
  </div>

  <!-- News items -->
  ${newsItemsHtml}
</div>`.trim();

  return { text, html };
}
