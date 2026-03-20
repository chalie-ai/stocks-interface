/**
 * @file src/capabilities/stock-compare.ts
 * @description Capability handler that compares up to five stocks side-by-side
 * in a sortable HTML table card.
 *
 * Invoked by the Chalie reasoning layer when the user asks to compare multiple
 * tickers (e.g. "Compare AAPL, MSFT, and GOOGL").
 *
 * ## Data sources
 * - **Quotes** — `GET /quote` via {@link FinnhubClient.quote} (one call per symbol).
 * - **P/E ratio** — sourced from `client.metricsCache` via
 *   {@link FinnhubClient.basicMetrics}, which is refreshed once per trading day.
 *   The P/E value shown is therefore **daily-stale** — it reflects the end-of-prior-
 *   day calculation, not a real-time figure. A footnote is included in the card.
 *   Displays `"N/A"` when the metric is unavailable (e.g. negative earnings, ETFs)
 *   or when the network request for metrics failed.
 *
 * ## Partial failure model
 * Quote and metrics fetches use `Promise.allSettled` so a single failed symbol
 * does not abort the whole comparison. Failed symbols appear in the table with
 * `"Error"` cells and the top-level `error` field summarises which symbols could
 * not be retrieved.
 *
 * ## Live / Delayed badge
 * A single badge is shown in the card header, derived from
 * `state.lastKnownMarketState` (same logic as {@link handleStockQuote}).
 *
 * @module stocks-interface/capabilities/stock-compare
 */

import type { FinnhubClient } from "../finnhub/client.ts";
import type { BasicMetrics, Quote, ToolState } from "../finnhub/types.ts";
import { escapeHtml } from "../utils.ts";
import type { CapabilityResult } from "../utils.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Maximum number of symbols accepted by {@link handleStockCompare}.
 * Enforced by slicing `params.symbols` before any API calls are made.
 */
const MAX_SYMBOLS = 5;

// ---------------------------------------------------------------------------
// Internal row model
// ---------------------------------------------------------------------------

/**
 * Aggregated data for one row of the comparison table.
 * Both `quote` and `metrics` may be `null` when the respective fetch failed.
 */
interface CompareRow {
  /** Upper-case ticker symbol. */
  symbol: string;
  /** Resolved quote data, or `null` on fetch failure. */
  quote: Quote | null;
  /**
   * Daily-cached basic metrics (used for P/E ratio).
   * `null` when the metrics fetch failed or returned no data.
   *
   * @remarks P/E is derived from Finnhub's `peNormalizedAnnual` metric and is
   * updated once per trading day, not in real time.
   */
  metrics: BasicMetrics | null;
  /** Error message if the quote fetch failed for this symbol. */
  quoteError: string | null;
}

// ---------------------------------------------------------------------------
// Internal formatting helpers
// ---------------------------------------------------------------------------

/**
 * Formats a numeric price as a localised USD currency string with two decimal
 * places.
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
 * Formats a P/E ratio to two decimal places, or returns `"N/A"` for null
 * values (negative-earnings companies, ETFs, or failed metrics fetches).
 *
 * @param pe - P/E ratio value, or `null` when unavailable.
 * @returns Formatted string such as `"28.40"` or `"N/A"`.
 */
function formatPE(pe: number | null | undefined): string {
  if (pe == null) return "N/A";
  return pe.toFixed(2);
}

/**
 * Returns the CSS hex colour for a signed numeric change value.
 * Positive → green, negative → red, zero or neutral → grey.
 *
 * @param value - The value whose sign determines the colour.
 * @returns A CSS hex colour string.
 */
function changeColor(value: number): string {
  if (value > 0) return "#16a34a";
  if (value < 0) return "#dc2626";
  return "rgba(234,230,242,0.55)";
}

/**
 * Derives Live / Delayed badge label and colours from `ToolState.lastKnownMarketState`.
 *
 * @param marketState - The current value of `state.lastKnownMarketState`.
 * @returns Object with `label`, `background`, and `color` for the badge element.
 */
function resolveBadge(
  marketState: ToolState["lastKnownMarketState"],
): { label: string; background: string; color: string } {
  if (marketState === "open") {
    return { label: "Live", background: "rgba(21,128,61,0.15)", color: "#15803d" };
  }
  return { label: "Delayed", background: "rgba(146,64,14,0.15)", color: "#92400e" };
}

// ---------------------------------------------------------------------------
// HTML row builder
// ---------------------------------------------------------------------------

/**
 * Renders one `<tr>` for the comparison table from a {@link CompareRow}.
 *
 * If `row.quote` is null (fetch failure), every data cell shows `"Error"` in
 * red so the table remains well-formed.
 *
 * @param row     - Aggregated data for this symbol row.
 * @param isEven  - `true` for even-indexed rows (0-based); drives alternating
 *   row background shading.
 * @returns An HTML `<tr>...</tr>` string.
 */
function buildTableRow(row: CompareRow, isEven: boolean): string {
  const rowBg = isEven ? "rgba(255,255,255,0.03)" : "transparent";

  if (row.quote === null) {
    const errMsg = escapeHtml(row.quoteError ?? "Unknown error");
    return `
    <tr style="background:${rowBg}">
      <td style="padding:8px 10px;font-weight:600;color:#eae6f2">${
      escapeHtml(row.symbol)
    }</td>
      <td style="padding:8px 10px;color:#dc2626;font-size:12px" colspan="5">
        Error: ${errMsg}
      </td>
    </tr>`.trim();
  }

  const q = row.quote;
  const pct = q.changePercent;
  const color = changeColor(pct);
  const name = escapeHtml(q.name ?? "");
  const peValue = row.metrics != null ? row.metrics.peRatio : null;

  return `
    <tr style="background:${rowBg}">
      <td style="padding:8px 10px">
        <span style="font-weight:700;color:#eae6f2">${
    escapeHtml(q.symbol)
  }</span>
        ${
    name ? `<br><span style="font-size:11px;color:rgba(234,230,242,0.55)">${name}</span>` : ""
  }
      </td>
      <td style="padding:8px 10px;font-weight:600;color:#eae6f2;text-align:right;
          white-space:nowrap">
        ${formatPrice(q.price)}
      </td>
      <td style="padding:8px 10px;font-weight:600;color:${color};text-align:right;
          white-space:nowrap">
        ${formatChangePercent(pct)}
      </td>
      <td style="padding:8px 10px;font-size:12px;color:rgba(234,230,242,0.85);text-align:right;
          white-space:nowrap">
        ${formatPrice(q.low)}&ndash;${formatPrice(q.high)}
      </td>
      <td style="padding:8px 10px;color:rgba(234,230,242,0.85);text-align:right;white-space:nowrap">
        ${formatPE(peValue)}
      </td>
    </tr>`.trim();
}

// ---------------------------------------------------------------------------
// Exported handler
// ---------------------------------------------------------------------------

/**
 * Fetches quotes (and cached P/E metrics) for up to {@link MAX_SYMBOLS} symbols
 * and returns a side-by-side comparison table as both an HTML card and a
 * plain-text summary.
 *
 * ### Columns
 * | Column | Source | Notes |
 * |--------|--------|-------|
 * | Symbol / Name | `Quote.symbol`, `Quote.name` | Name from profile cache |
 * | Price | `Quote.price` | Current price |
 * | Change % | `Quote.changePercent` | Intraday, colour-coded |
 * | Day Range | `Quote.low`–`Quote.high` | Session high / low |
 * | P/E | `BasicMetrics.peRatio` | **Daily-cached** — stale up to 24 h; `"N/A"` for ETFs, negative-earnings stocks, or fetch failures |
 *
 * ### Partial failure handling
 * Symbols whose quote fetch fails are still shown in the table with an inline
 * error message. The top-level `error` field is set when one or more symbols
 * could not be resolved.
 *
 * @param params          - Handler parameters.
 * @param params.symbols  - Array of ticker symbols to compare (case-insensitive;
 *   normalised to upper-case internally). Silently truncated to
 *   {@link MAX_SYMBOLS} entries if more are supplied.
 * @param client          - Configured {@link FinnhubClient} instance. Quote and
 *   metrics fetches are dispatched concurrently via `Promise.allSettled`.
 * @param state           - Current {@link ToolState}; `lastKnownMarketState`
 *   drives the Live / Delayed badge.
 * @returns A resolved {@link CapabilityResult} — never rejects.
 *
 * @example
 * ```ts
 * const result = await handleStockCompare(
 *   { symbols: ["AAPL", "MSFT", "GOOGL"] },
 *   client,
 *   state,
 * );
 * console.log(result.text);
 * // "Comparison (3 stocks): AAPL $178.50 +1.33% P/E 29.12 | ..."
 * ```
 */
export async function handleStockCompare(
  params: { symbols: string[] },
  client: FinnhubClient,
  state: ToolState,
): Promise<CapabilityResult> {
  // ── Validate and normalise input ──────────────────────────────────────────
  const symbols = params.symbols
    .slice(0, MAX_SYMBOLS)
    .map((s) => s.toUpperCase().trim())
    .filter((s) => s.length > 0);

  if (symbols.length === 0) {
    const msg = "No symbols provided for comparison.";
    return {
      text: msg,
      html:
        `<p style="font-family:system-ui,sans-serif;color:#dc2626">${msg}</p>`,
      error: msg,
    };
  }

  // ── Fetch quotes and metrics concurrently ─────────────────────────────────
  // Both sets use Promise.allSettled so a single failure does not abort the
  // whole comparison. Metrics are served from the daily cache by basicMetrics()
  // without an extra API call when up to date.
  const [quoteSettled, metricsSettled] = await Promise.all([
    Promise.allSettled(symbols.map((s) => client.quote(s))),
    Promise.allSettled(symbols.map((s) => client.basicMetrics(s))),
  ]);

  // ── Build rows ────────────────────────────────────────────────────────────
  const rows: CompareRow[] = symbols.map((symbol, i) => {
    const quoteResult = quoteSettled[i];
    const metricsResult = metricsSettled[i];

    const quote =
      quoteResult !== undefined && quoteResult.status === "fulfilled"
        ? quoteResult.value
        : null;

    const quoteError =
      quoteResult !== undefined && quoteResult.status === "rejected"
        ? (quoteResult.reason instanceof Error
          ? quoteResult.reason.message
          : String(quoteResult.reason))
        : null;

    const metrics =
      metricsResult !== undefined && metricsResult.status === "fulfilled"
        ? metricsResult.value
        : null;

    return { symbol, quote, metrics, quoteError };
  });

  // ── Collect failed symbols for the error field ────────────────────────────
  const failedSymbols = rows
    .filter((r) => r.quote === null)
    .map((r) => r.symbol);

  const errorSummary = failedSymbols.length > 0
    ? `Failed to fetch data for: ${failedSymbols.join(", ")}`
    : undefined;

  // ── Plain-text summary ────────────────────────────────────────────────────
  const successRows = rows.filter((r) => r.quote !== null);
  const textParts = successRows.map((r) => {
    const q = r.quote!; // narrowed above
    const pe = r.metrics != null ? r.metrics.peRatio : null;
    return (
      `${q.symbol} ${formatPrice(q.price)} ` +
      `${formatChangePercent(q.changePercent)} ` +
      `P/E ${formatPE(pe)}`
    );
  });

  const text =
    `Comparison (${symbols.length} stock${symbols.length !== 1 ? "s" : ""}): ` +
    (textParts.length > 0 ? textParts.join(" | ") : "No data available.") +
    " [P/E is daily-cached, not real-time]";

  // ── HTML card ─────────────────────────────────────────────────────────────
  const badge = resolveBadge(state.lastKnownMarketState);
  const tableRows = rows
    .map((row, i) => buildTableRow(row, i % 2 === 0))
    .join("\n");

  const html = `
<div style="font-family:system-ui,sans-serif;background:transparent;border:1px solid rgba(255,255,255,0.08);
    border-radius:8px;padding:16px;max-width:680px">

  <!-- Card header -->
  <div style="display:flex;justify-content:space-between;align-items:center;
      margin-bottom:12px">
    <span style="font-size:15px;font-weight:700;color:#eae6f2">
      Stock Comparison
    </span>
    <span style="font-size:11px;font-weight:600;padding:2px 8px;border-radius:12px;
        white-space:nowrap;background:${badge.background};color:${badge.color}">
      ${badge.label}
    </span>
  </div>

  <!-- Comparison table -->
  <table style="width:100%;border-collapse:collapse;font-size:13px">
    <thead>
      <tr style="background:rgba(255,255,255,0.05)">
        <th style="padding:8px 10px;text-align:left;font-weight:600;color:rgba(234,230,242,0.85);
            border-bottom:2px solid rgba(255,255,255,0.08)">Symbol</th>
        <th style="padding:8px 10px;text-align:right;font-weight:600;color:rgba(234,230,242,0.85);
            border-bottom:2px solid rgba(255,255,255,0.08)">Price</th>
        <th style="padding:8px 10px;text-align:right;font-weight:600;color:rgba(234,230,242,0.85);
            border-bottom:2px solid rgba(255,255,255,0.08)">Change %</th>
        <th style="padding:8px 10px;text-align:right;font-weight:600;color:rgba(234,230,242,0.85);
            border-bottom:2px solid rgba(255,255,255,0.08)">Day Range</th>
        <th style="padding:8px 10px;text-align:right;font-weight:600;color:rgba(234,230,242,0.85);
            border-bottom:2px solid rgba(255,255,255,0.08)">P/E</th>
      </tr>
    </thead>
    <tbody>
      ${tableRows}
    </tbody>
  </table>

  <!-- P/E staleness footnote -->
  <p style="margin:10px 0 0;font-size:11px;color:rgba(234,230,242,0.38)">
    P/E ratio is sourced from daily-cached metrics (refreshed once per trading
    day) and may be up to 24 hours stale. &ldquo;N/A&rdquo; indicates the metric
    is unavailable for this symbol (e.g. negative earnings, ETFs).
  </p>
</div>`.trim();

  return {
    text,
    html,
    ...(errorSummary !== undefined ? { error: errorSummary } : {}),
  };
}
