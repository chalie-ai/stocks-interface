/**
 * @file src/capabilities/stock-history.ts
 * @description Capability handler that fetches OHLCV candlestick history for a
 * single symbol and renders a price-history card with an inline SVG sparkline.
 *
 * Invoked by the Chalie reasoning layer when the user asks about historical
 * performance (e.g. "How has AAPL done over the last 30 days?"). The LLM maps
 * natural-language time expressions to the strict {@link HistoryPeriod} enum —
 * this handler accepts only the enum values and does **not** parse free-text.
 *
 * ## Data sources
 * - **OHLCV candles** — `GET /stock/candle` with daily resolution (`"D"`) via
 *   {@link FinnhubClient.candles}. One API call per invocation.
 *
 * ## SVG sparkline
 * The sparkline is rendered as an inline `<polyline>` element with no external
 * libraries. Close prices are normalised into SVG viewport coordinates using a
 * min/max linear scale. Line colour is green for a positive period return and
 * red for a negative one.
 *
 * ## Period semantics
 * | Period | `from` timestamp | `to` timestamp |
 * |--------|-----------------|----------------|
 * | `"7d"` | now − 7 days | now |
 * | `"30d"` | now − 30 days | now |
 * | `"90d"` | now − 90 days | now |
 * | `"1y"` | now − 365 days | now |
 * | `"ytd"` | Jan 1 00:00 UTC of the current year | now |
 *
 * @module stocks-interface/capabilities/stock-history
 */

import type { FinnhubClient } from "../finnhub/client.ts";
import type { ToolState } from "../finnhub/types.ts";
import { escapeHtml } from "../utils.ts";
import type { CapabilityResult } from "../utils.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Accepted period values for {@link handleStockHistory}.
 *
 * The LLM maps natural-language expressions to these values before invoking
 * the handler. This type is intentionally a strict enum — no free-text parsing
 * is performed inside the handler.
 */
export type HistoryPeriod = "7d" | "30d" | "90d" | "1y" | "ytd";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Number of seconds in one calendar day. */
const DAY_SECONDS = 86_400;

/** SVG viewport width in user units. */
const SVG_WIDTH = 400;

/** SVG viewport height in user units. */
const SVG_HEIGHT = 60;

/** Inner padding (user units) applied to all four edges of the sparkline. */
const SVG_PADDING = 4;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Maps a {@link HistoryPeriod} to `[from, to]` Unix timestamps in **seconds**
 * suitable for passing to {@link FinnhubClient.candles}.
 *
 * `"ytd"` uses midnight UTC on 1 January of the current calendar year as the
 * start boundary so the result is consistent regardless of the caller's locale.
 *
 * @param period - One of the accepted period enum values.
 * @returns An object containing `from` and `to` as Unix second timestamps.
 */
function periodToRange(period: HistoryPeriod): { from: number; to: number } {
  const nowSeconds = Math.floor(Date.now() / 1_000);

  switch (period) {
    case "7d":
      return { from: nowSeconds - 7 * DAY_SECONDS, to: nowSeconds };
    case "30d":
      return { from: nowSeconds - 30 * DAY_SECONDS, to: nowSeconds };
    case "90d":
      return { from: nowSeconds - 90 * DAY_SECONDS, to: nowSeconds };
    case "1y":
      return { from: nowSeconds - 365 * DAY_SECONDS, to: nowSeconds };
    case "ytd": {
      const year = new Date().getUTCFullYear();
      const jan1Seconds = Math.floor(
        new Date(`${year}-01-01T00:00:00Z`).getTime() / 1_000,
      );
      return { from: jan1Seconds, to: nowSeconds };
    }
  }
}

/**
 * Returns a human-readable display label for a {@link HistoryPeriod}.
 *
 * @param period - One of the accepted period enum values.
 * @returns A short English label (e.g. `"30 Days"`, `"Year to Date"`).
 */
function periodLabel(period: HistoryPeriod): string {
  switch (period) {
    case "7d":
      return "7 Days";
    case "30d":
      return "30 Days";
    case "90d":
      return "90 Days";
    case "1y":
      return "1 Year";
    case "ytd":
      return "Year to Date";
  }
}

/**
 * Renders an inline SVG sparkline from an array of close prices.
 *
 * The prices are linearly normalised between the viewport padding boundaries
 * using `min` and `max` of the series. When all prices are equal the line is
 * drawn horizontally at mid-height (range degeneracy guard avoids division by
 * zero). The line colour reflects whether the period return is positive or
 * negative.
 *
 * @param closes         - Ordered array of close prices (chronological).
 * @param positiveReturn - `true` when `endPrice >= startPrice`; drives colour.
 * @returns An inline `<svg>…</svg>` string safe to embed in HTML.
 */
function renderSparklineSvg(
  closes: number[],
  positiveReturn: boolean,
): string {
  if (closes.length === 0) {
    // Return an empty placeholder when no data is available.
    return (
      `<svg width="${SVG_WIDTH}" height="${SVG_HEIGHT}" ` +
      `viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}" ` +
      `xmlns="http://www.w3.org/2000/svg">` +
      `<text x="${SVG_WIDTH / 2}" y="${SVG_HEIGHT / 2}" ` +
      `text-anchor="middle" dominant-baseline="middle" ` +
      `fill="rgba(234,230,242,0.38)" font-family="system-ui,sans-serif" font-size="12">` +
      `No data</text></svg>`
    );
  }

  const minPrice = Math.min(...closes);
  const maxPrice = Math.max(...closes);
  // Prevent division by zero when all closes are identical.
  const priceRange = maxPrice - minPrice || 1;

  const innerW = SVG_WIDTH - 2 * SVG_PADDING;
  const innerH = SVG_HEIGHT - 2 * SVG_PADDING;

  const points = closes
    .map((price, i) => {
      const x = SVG_PADDING + (i / Math.max(closes.length - 1, 1)) * innerW;
      // SVG y-axis is inverted: higher prices map to smaller y values.
      const y = SVG_HEIGHT - SVG_PADDING -
        ((price - minPrice) / priceRange) * innerH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  const strokeColor = positiveReturn ? "#16a34a" : "#dc2626";

  return (
    `<svg width="${SVG_WIDTH}" height="${SVG_HEIGHT}" ` +
    `viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}" ` +
    `xmlns="http://www.w3.org/2000/svg" ` +
    `style="display:block;width:100%;height:auto">` +
    `<polyline points="${points}" fill="none" stroke="${strokeColor}" ` +
    `stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>` +
    `</svg>`
  );
}

/**
 * Formats a numeric price as a localised USD currency string.
 *
 * @param price - Raw numeric price value.
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

// ---------------------------------------------------------------------------
// Exported handler
// ---------------------------------------------------------------------------

/**
 * Fetches daily OHLCV candle data for a symbol over the requested period and
 * returns a rich history card alongside a plain-text summary.
 *
 * ### HTML card contents
 * - Symbol and period label in the header
 * - Total return percentage (colour-coded; positive = green, negative = red)
 * - Inline SVG sparkline rendered from daily close prices
 * - Start price, end price, period high, period low, and total return % in a
 *   stats grid
 *
 * ### Period resolution
 * All periods use Finnhub's **daily** (`"D"`) candle resolution. Intraday
 * candles are not used because they are not needed for the supported periods
 * and would consume significantly more API quota.
 *
 * ### No-data handling
 * When Finnhub returns `status: "no_data"` (e.g. for very new symbols or
 * holidays filling the entire range), a user-friendly message is returned
 * without an `error` field (it is expected and not an API error).
 *
 * ### Error handling
 * On any Finnhub error the function resolves (not rejects) with a
 * {@link CapabilityResult} that has `error` set and a user-facing HTML message.
 *
 * @param params        - Handler parameters.
 * @param params.symbol - Ticker symbol to look up (case-insensitive; normalised
 *   to upper-case internally).
 * @param params.period - Time period for the history query. Must be one of the
 *   {@link HistoryPeriod} enum values. Natural-language mapping is performed by
 *   the LLM before this function is called — no NL parsing is done here.
 * @param client        - Configured {@link FinnhubClient} instance.
 * @param _state        - Current {@link ToolState}. Accepted for interface
 *   consistency with other capability handlers; not used by this handler.
 * @returns A resolved {@link CapabilityResult} — never rejects.
 *
 * @example
 * ```ts
 * const result = await handleStockHistory(
 *   { symbol: "AAPL", period: "30d" },
 *   client,
 *   state,
 * );
 * console.log(result.text);
 * // "AAPL — 30 Days History: Start $162.00, End $178.50, Return +10.19% | ..."
 * ```
 */
export async function handleStockHistory(
  params: { symbol: string; period: HistoryPeriod },
  client: FinnhubClient,
  _state: ToolState,
): Promise<CapabilityResult> {
  const symbol = params.symbol.toUpperCase().trim();
  const { from, to } = periodToRange(params.period);
  const label = periodLabel(params.period);

  // ── Fetch candle data ─────────────────────────────────────────────────────
  let candles: Awaited<ReturnType<FinnhubClient["candles"]>>;
  try {
    candles = await client.candles(symbol, "D", from, to);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const html = `
<div style="font-family:system-ui,sans-serif;background:transparent;border:1px solid rgba(220,38,38,0.3);
    border-radius:8px;padding:16px;max-width:520px">
  <p style="margin:0;color:#dc2626;font-size:14px">
    <strong>Error fetching ${escapeHtml(symbol)} history:</strong> ${
      escapeHtml(msg)
    }
  </p>
</div>`.trim();
    return {
      text: `Error fetching history for ${symbol} (${label}): ${msg}`,
      html,
      error: msg,
    };
  }

  // ── Handle no-data response ───────────────────────────────────────────────
  if (candles.status === "no_data" || candles.c.length === 0) {
    const msg =
      `No price history available for ${symbol} over the selected period (${label}).`;
    const html = `
<div style="font-family:system-ui,sans-serif;background:transparent;border:1px solid rgba(255,255,255,0.08);
    border-radius:8px;padding:16px;max-width:520px">
  <p style="margin:0;color:rgba(234,230,242,0.55);font-size:14px">${escapeHtml(msg)}</p>
</div>`.trim();
    return { text: msg, html };
  }

  // ── Derive statistics ─────────────────────────────────────────────────────
  const closes = candles.c;
  const highs = candles.h;
  const lows = candles.l;

  // Non-null assertions are safe: we verified closes.length > 0 above.
  const startPrice = closes[0]!;
  const endPrice = closes[closes.length - 1]!;
  const periodHigh = Math.max(...highs);
  const periodLow = Math.min(...lows);
  const totalReturn = ((endPrice - startPrice) / startPrice) * 100;
  const positiveReturn = totalReturn >= 0;
  const returnSign = positiveReturn ? "+" : "";
  const returnColor = positiveReturn ? "#16a34a" : "#dc2626";

  // ── Render sparkline ──────────────────────────────────────────────────────
  const sparklineSvg = renderSparklineSvg(closes, positiveReturn);

  // ── Plain-text summary ────────────────────────────────────────────────────
  const text = `${symbol} — ${label} History: ` +
    `Start ${formatPrice(startPrice)}, End ${formatPrice(endPrice)}, ` +
    `Return ${returnSign}${totalReturn.toFixed(2)}% | ` +
    `Period High ${formatPrice(periodHigh)}, Low ${formatPrice(periodLow)}`;

  // ── HTML card ─────────────────────────────────────────────────────────────
  const html = `
<div style="font-family:system-ui,sans-serif;background:transparent;border:1px solid rgba(255,255,255,0.08);
    border-radius:8px;padding:16px;max-width:520px">

  <!-- Header: symbol + period + return badge -->
  <div style="display:flex;justify-content:space-between;align-items:center;
      margin-bottom:12px">
    <div>
      <span style="font-size:18px;font-weight:700;color:#eae6f2">
        ${escapeHtml(symbol)}
      </span>
      <span style="font-size:13px;color:rgba(234,230,242,0.55);margin-left:8px">
        ${escapeHtml(label)}
      </span>
    </div>
    <span style="font-size:16px;font-weight:700;color:${returnColor}">
      ${returnSign}${totalReturn.toFixed(2)}%
    </span>
  </div>

  <!-- Sparkline -->
  <div style="margin-bottom:12px;border:1px solid rgba(255,255,255,0.06);border-radius:4px;
      overflow:hidden;background:rgba(255,255,255,0.03)">
    ${sparklineSvg}
  </div>

  <!-- Stats grid -->
  <table style="width:100%;border-collapse:collapse;font-size:13px;color:rgba(234,230,242,0.85)">
    <tbody>
      <tr style="border-top:1px solid rgba(255,255,255,0.06)">
        <td style="padding:6px 4px;color:rgba(234,230,242,0.55)">Start Price</td>
        <td style="padding:6px 4px;font-weight:500;text-align:right">
          ${formatPrice(startPrice)}
        </td>
        <td style="padding:6px 4px;color:rgba(234,230,242,0.55);padding-left:20px">End Price</td>
        <td style="padding:6px 4px;font-weight:500;text-align:right">
          ${formatPrice(endPrice)}
        </td>
      </tr>
      <tr style="border-top:1px solid rgba(255,255,255,0.06)">
        <td style="padding:6px 4px;color:rgba(234,230,242,0.55)">Period High</td>
        <td style="padding:6px 4px;font-weight:500;text-align:right">
          ${formatPrice(periodHigh)}
        </td>
        <td style="padding:6px 4px;color:rgba(234,230,242,0.55);padding-left:20px">Period Low</td>
        <td style="padding:6px 4px;font-weight:500;text-align:right">
          ${formatPrice(periodLow)}
        </td>
      </tr>
      <tr style="border-top:1px solid rgba(255,255,255,0.06)">
        <td style="padding:6px 4px;color:rgba(234,230,242,0.55)">Total Return</td>
        <td style="padding:6px 4px;font-weight:600;color:${returnColor};text-align:right"
            colspan="3">
          ${returnSign}${totalReturn.toFixed(2)}%
          &nbsp;(${formatPrice(startPrice)} &rarr; ${formatPrice(endPrice)})
        </td>
      </tr>
    </tbody>
  </table>
</div>`.trim();

  return { text, html };
}
