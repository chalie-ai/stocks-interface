/**
 * @file src/capabilities/stock-quote.ts
 * @description Capability handler that fetches and renders a real-time stock
 * quote card for a single symbol.
 *
 * Invoked by the Chalie reasoning layer when the user asks for a price or
 * summary of a specific ticker (e.g. "What is Apple trading at?").
 *
 * ## Data sources
 * - **Price data** — `GET /quote` via {@link FinnhubClient.quote}.
 * - **Company name** — resolved from `client.profileCache` (pre-warmed by the
 *   sync cycle); `"N/A"` is shown on a cache miss without blocking the call.
 *
 * ## Live / Delayed badge
 * The badge reflects `state.lastKnownMarketState`:
 * - `"open"` → **Live** (green badge): data was just fetched during an active
 *   trading session.
 * - All other states (`"pre"`, `"after"`, `"closed"`, `null`) → **Delayed**
 *   (amber badge): the market is not in its regular trading session so the
 *   price shown is the most-recent available tick, not a real-time feed.
 *
 * @module stocks-interface/capabilities/stock-quote
 */

import type { FinnhubClient } from "../finnhub/client.ts";
import type { ToolState } from "../finnhub/types.ts";

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

/**
 * The result returned by every capability handler in this tool.
 *
 * Both `text` and `html` representations are always populated on success so
 * Chalie can choose the best rendering surface. `error` is set only when the
 * handler could not complete the request.
 */
export interface CapabilityResult {
  /** Plain-text summary suitable for Chalie's reasoning context. */
  text: string;
  /**
   * Inline-CSS HTML card for rich rendering in the Chalie UI.
   * Never contains `<script>` tags.
   */
  html: string;
  /**
   * Human-readable error message when the handler failed.
   * Absent on success. `text` and `html` will contain user-facing error copy
   * even when this field is set.
   */
  error?: string;
}

// ---------------------------------------------------------------------------
// Internal formatting helpers
// ---------------------------------------------------------------------------

/**
 * Formats a numeric price as a localised USD currency string.
 *
 * @param price - Raw price value (e.g. `178.5`).
 * @returns Formatted string such as `"$178.50"`.
 */
function formatPrice(price: number): string {
  return price.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/**
 * Formats an absolute price change with an explicit `+` prefix for gains.
 *
 * @param change - Signed change value (e.g. `2.35` or `-1.10`).
 * @returns Formatted string such as `"+2.35"` or `"-1.10"`.
 */
function formatChange(change: number): string {
  const sign = change >= 0 ? "+" : "";
  return `${sign}${change.toFixed(2)}`;
}

/**
 * Formats a percentage change with an explicit `+` prefix for gains and a
 * trailing `%` suffix.
 *
 * @param pct - Signed percentage value (e.g. `1.32` or `-0.61`).
 * @returns Formatted string such as `"+1.32%"` or `"-0.61%"`.
 */
function formatChangePercent(pct: number): string {
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

/**
 * Formats a raw trading volume using K / M / B suffixes for readability.
 * Returns `"N/A"` when the volume is zero (not available on the Finnhub
 * free-tier `/quote` endpoint).
 *
 * @param volume - Raw integer volume (e.g. `23_400_000`).
 * @returns Human-readable string such as `"23.4M"`, `"450K"`, or `"N/A"`.
 */
function formatVolume(volume: number): string {
  if (volume === 0) return "N/A";
  if (volume >= 1_000_000_000) return `${(volume / 1_000_000_000).toFixed(1)}B`;
  if (volume >= 1_000_000) return `${(volume / 1_000_000).toFixed(1)}M`;
  if (volume >= 1_000) return `${(volume / 1_000).toFixed(0)}K`;
  return volume.toLocaleString("en-US");
}

/**
 * Returns the CSS hex colour for a signed numeric value.
 * Positive → green, negative → red, zero → neutral grey.
 *
 * @param value - The value whose sign determines the colour.
 * @returns A CSS hex colour string.
 */
function changeColor(value: number): string {
  if (value > 0) return "#16a34a";
  if (value < 0) return "#dc2626";
  return "#6b7280";
}

/**
 * Derives the Live / Delayed badge label and its associated colours from the
 * last-known market state stored in `ToolState`.
 *
 * @param marketState - Value of `state.lastKnownMarketState`.
 * @returns An object containing `label`, `background`, and `color` fields for
 *          rendering the badge.
 */
function resolveBadge(
  marketState: ToolState["lastKnownMarketState"],
): { label: string; background: string; color: string } {
  if (marketState === "open") {
    return { label: "Live", background: "#dcfce7", color: "#15803d" };
  }
  return { label: "Delayed", background: "#fef9c3", color: "#92400e" };
}

// ---------------------------------------------------------------------------
// Exported handler
// ---------------------------------------------------------------------------

/**
 * Fetches a real-time quote for a single symbol and returns a rich HTML card
 * alongside a plain-text summary for Chalie's reasoning context.
 *
 * ### HTML card contents
 * - Symbol and company name (or `"N/A"` on profile-cache miss)
 * - Live / Delayed badge (derived from `state.lastKnownMarketState`)
 * - Current price with signed change and percentage change (colour-coded)
 * - Day high / low, open, previous close
 * - Intraday volume (shown as `"N/A"` on the Finnhub free tier because the
 *   `/quote` endpoint does not return volume)
 *
 * ### Error handling
 * On any Finnhub error the function resolves (not rejects) with a
 * {@link CapabilityResult} that has `error` set. The `html` field contains a
 * user-friendly error message safe to render in the UI.
 *
 * @param params  - Handler parameters.
 * @param params.symbol - Ticker symbol to look up (case-insensitive;
 *   normalised to upper-case internally).
 * @param client  - Configured {@link FinnhubClient} instance with its
 *   profile cache pre-warmed by the sync layer.
 * @param state   - Current {@link ToolState}; `lastKnownMarketState` drives
 *   the Live / Delayed badge.
 * @returns A resolved {@link CapabilityResult} — never rejects.
 *
 * @example
 * ```ts
 * const result = await handleStockQuote({ symbol: "AAPL" }, client, state);
 * console.log(result.text);
 * // "AAPL (Apple Inc): $178.50 +2.35 (+1.33%) | Day range: $176.10–$179.80 | ..."
 * ```
 */
export async function handleStockQuote(
  params: { symbol: string },
  client: FinnhubClient,
  state: ToolState,
): Promise<CapabilityResult> {
  const symbol = params.symbol.toUpperCase().trim();

  // ── Fetch quote ──────────────────────────────────────────────────────────
  let quote: Awaited<ReturnType<FinnhubClient["quote"]>>;
  try {
    quote = await client.quote(symbol);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const html = `
<div style="font-family:system-ui,sans-serif;background:#fff;border:1px solid #fecaca;
    border-radius:8px;padding:16px;max-width:480px">
  <p style="margin:0;color:#dc2626;font-size:14px">
    <strong>Error fetching ${symbol}:</strong> ${escapeHtml(msg)}
  </p>
</div>`.trim();

    return {
      text: `Error fetching quote for ${symbol}: ${msg}`,
      html,
      error: msg,
    };
  }

  // ── Derive display values ─────────────────────────────────────────────────
  const name = quote.name ?? "N/A";
  const color = changeColor(quote.changePercent);
  const badge = resolveBadge(state.lastKnownMarketState);

  // ── Plain-text summary (used in Chalie's reasoning context) ───────────────
  const text =
    `${symbol} (${name}): ${formatPrice(quote.price)} ` +
    `${formatChange(quote.change)} (${formatChangePercent(quote.changePercent)}) | ` +
    `Day range: ${formatPrice(quote.low)}–${formatPrice(quote.high)} | ` +
    `Open: ${formatPrice(quote.open)} | ` +
    `Prev close: ${formatPrice(quote.previousClose)} | ` +
    `Volume: ${formatVolume(quote.volume)}`;

  // ── HTML card ─────────────────────────────────────────────────────────────
  const html = `
<div style="font-family:system-ui,sans-serif;background:#fff;border:1px solid #e5e7eb;
    border-radius:8px;padding:16px;max-width:480px;
    box-shadow:0 1px 3px rgba(0,0,0,0.08)">

  <!-- Header: symbol + badge -->
  <div style="display:flex;justify-content:space-between;align-items:flex-start;
      margin-bottom:6px">
    <div>
      <span style="font-size:20px;font-weight:700;color:#111827">${escapeHtml(symbol)}</span>
      <span style="font-size:13px;color:#6b7280;margin-left:8px">${escapeHtml(name)}</span>
    </div>
    <span style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:12px;
        white-space:nowrap;background:${badge.background};color:${badge.color}">
      ${badge.label}
    </span>
  </div>

  <!-- Price + change -->
  <div style="margin-bottom:14px">
    <span style="font-size:28px;font-weight:700;color:#111827">
      ${formatPrice(quote.price)}
    </span>
    <span style="font-size:15px;font-weight:600;color:${color};margin-left:8px">
      ${formatChange(quote.change)} (${formatChangePercent(quote.changePercent)})
    </span>
  </div>

  <!-- Detail grid -->
  <table style="width:100%;border-collapse:collapse;font-size:13px;color:#374151">
    <tbody>
      <tr style="border-top:1px solid #f3f4f6">
        <td style="padding:6px 4px;color:#6b7280">Day High</td>
        <td style="padding:6px 4px;font-weight:500;text-align:right">
          ${formatPrice(quote.high)}
        </td>
        <td style="padding:6px 4px;color:#6b7280;padding-left:20px">Day Low</td>
        <td style="padding:6px 4px;font-weight:500;text-align:right">
          ${formatPrice(quote.low)}
        </td>
      </tr>
      <tr style="border-top:1px solid #f3f4f6">
        <td style="padding:6px 4px;color:#6b7280">Open</td>
        <td style="padding:6px 4px;font-weight:500;text-align:right">
          ${formatPrice(quote.open)}
        </td>
        <td style="padding:6px 4px;color:#6b7280;padding-left:20px">Prev Close</td>
        <td style="padding:6px 4px;font-weight:500;text-align:right">
          ${formatPrice(quote.previousClose)}
        </td>
      </tr>
      <tr style="border-top:1px solid #f3f4f6">
        <td style="padding:6px 4px;color:#6b7280">Volume</td>
        <td style="padding:6px 4px;font-weight:500;text-align:right" colspan="3">
          ${formatVolume(quote.volume)}
        </td>
      </tr>
    </tbody>
  </table>
</div>`.trim();

  return { text, html };
}

// ---------------------------------------------------------------------------
// Internal utility
// ---------------------------------------------------------------------------

/**
 * Escapes a string for safe interpolation into an HTML attribute or text node.
 * Prevents XSS when user-supplied symbol names or server responses are
 * rendered directly into the HTML card.
 *
 * @param str - Raw string to escape.
 * @returns HTML-safe string with `&`, `<`, `>`, `"`, and `'` replaced by
 *   their named entity equivalents.
 */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
