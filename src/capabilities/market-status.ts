/**
 * @file src/capabilities/market-status.ts
 * @description Capability handlers for US market status and earnings calendar.
 *
 * Exports two public handlers:
 *
 * ### `handleMarketStatus`
 * Fetches the current open/closed state of the US equity market and renders an
 * HTML card showing:
 * - Market phase label (Open · Pre-Market · After-Hours · Closed)
 * - Current time in US Eastern Time (ET)
 * - Holiday notice when the market is closed due to a named holiday
 * - Index ETF summary (SPY, QQQ, DIA) — prices and change% fetched from the
 *   Finnhub API via fresh quote calls, or "data unavailable" on fetch failure
 * - Next scheduled market open or close time, shown in both ET and the
 *   process's local timezone (which equals the user's timezone when the tool
 *   runs on their machine)
 *
 * ### `handleEarningsCalendar`
 * Fetches upcoming earnings events from Finnhub's `GET /calendar/earnings`
 * endpoint for the next `daysAhead` calendar days (default: 7). When a
 * `symbol` is provided, results are filtered to that ticker. Displays the
 * report date, pre/post-market timing, and EPS estimate for each event.
 *
 * ## HTML constraints
 * All HTML is rendered with inline CSS only. No `<script>` tags are emitted.
 *
 * @module stocks-interface/capabilities/market-status
 */

import type { EarningsEntry, FinnhubClient } from "../finnhub/client.ts";
import type { Quote, ToolState } from "../finnhub/types.ts";
import { escapeHtml } from "../utils.ts";
import type { CapabilityResult } from "../utils.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * IANA timezone identifier for US Eastern Time.
 * Handles EDT ↔ EST transitions automatically via `Intl.DateTimeFormat`.
 */
const ET_TIMEZONE = "America/New_York";

/**
 * The three index-proxy ETFs always included in the market status summary.
 * Tuple order determines display order (top to bottom) in the HTML card.
 */
const INDEX_SYMBOLS = ["SPY", "QQQ", "DIA"] as const;

/**
 * Human-readable names for the index-proxy ETFs shown in the summary table.
 */
const INDEX_NAMES: Readonly<Record<string, string>> = {
  SPY: "S&P 500 (SPY)",
  QQQ: "NASDAQ 100 (QQQ)",
  DIA: "Dow Jones (DIA)",
};

/**
 * Regular trading session open time in ET: 9:30 AM.
 */
const MARKET_OPEN_HOUR_ET = 9;
const MARKET_OPEN_MINUTE_ET = 30;

/**
 * Regular trading session close time in ET: 4:00 PM.
 */
const MARKET_CLOSE_HOUR_ET = 16;
const MARKET_CLOSE_MINUTE_ET = 0;

/**
 * Pre-market session starts at 4:00 AM ET.
 */
const PREMARKET_START_HOUR_ET = 4;

/**
 * After-hours session ends at 8:00 PM ET.
 */
const AFTERHOURS_END_HOUR_ET = 20;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

/**
 * Parsed ET datetime components extracted from a `Date` object.
 * All numeric fields are in integer form (no leading zeroes).
 */
interface EtTimeParts {
  /** Four-digit year (e.g. `2024`). */
  year: number;
  /** Month 1–12. */
  month: number;
  /** Day of month 1–31. */
  day: number;
  /** Hour 0–23 (24-hour clock). */
  hour: number;
  /** Minute 0–59. */
  minute: number;
  /**
   * Full English weekday name (e.g. `"Monday"`).
   * Matches the keys of {@link WEEKDAY_NUMS}.
   */
  weekday: string;
}

/**
 * Maps English weekday name to ISO weekday number (Sunday = 0 … Saturday = 6).
 */
const WEEKDAY_NUMS: Readonly<Record<string, number>> = {
  Sunday: 0,
  Monday: 1,
  Tuesday: 2,
  Wednesday: 3,
  Thursday: 4,
  Friday: 5,
  Saturday: 6,
};

/**
 * A styled badge for the market phase chip displayed in the HTML card header.
 */
interface PhaseBadge {
  /** Short display label (e.g. `"Open"`, `"Pre-Market"`). */
  label: string;
  /** CSS background-color value. */
  background: string;
  /** CSS color value for the text. */
  color: string;
}

// ---------------------------------------------------------------------------
// Internal utility functions
// ---------------------------------------------------------------------------

/**
 * Pads a number to two digits with a leading zero if necessary.
 *
 * @param n - Non-negative integer to pad.
 * @returns Two-character string (e.g. `9` → `"09"`, `14` → `"14"`).
 */
function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * Extracts ET date and time components from a `Date` object by formatting
 * through `Intl.DateTimeFormat` with the `America/New_York` timezone.
 *
 * Uses `formatToParts` to avoid locale-specific number formatting issues and
 * to reliably separate the individual fields.
 *
 * @param date - The point in time to decompose.
 * @returns An {@link EtTimeParts} object with integer fields.
 */
function getEtTimeParts(date: Date): EtTimeParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "long",
    hour12: false,
  });

  const parts: Record<string, string> = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") {
      parts[part.type] = part.value;
    }
  }

  return {
    year: parseInt(parts["year"] ?? "0", 10),
    month: parseInt(parts["month"] ?? "0", 10),
    day: parseInt(parts["day"] ?? "0", 10),
    // Intl hour12:false can return "24" for midnight; normalise to 0.
    hour: parseInt(parts["hour"] ?? "0", 10) % 24,
    minute: parseInt(parts["minute"] ?? "0", 10),
    weekday: parts["weekday"] ?? "Monday",
  };
}

/**
 * Formats a `Date` in the process's local timezone (= user's timezone when
 * the tool runs on their machine) as a concise human-readable string such as
 * `"Jan 26, 9:30 AM PST"`.
 *
 * @param date - The moment to format.
 * @returns Localised datetime string including the abbreviated timezone name.
 */
function formatLocalDateTime(date: Date): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    hour12: true,
  }).format(date);
}

/**
 * Formats a `Date` in ET as a time-only string such as `"9:30 AM ET"`.
 *
 * @param date - The moment to format.
 * @returns ET time string with abbreviated timezone suffix.
 */
function formatEtTime(date: Date): string {
  const etStr = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
  return `${etStr} ET`;
}

/**
 * Constructs a `Date` object corresponding to a specific clock time in the
 * America/New_York timezone on the given calendar date.
 *
 * The function tries both EST (UTC−5) and EDT (UTC−4) offsets and returns
 * whichever candidate correctly maps back to the requested ET hour via
 * `Intl.DateTimeFormat`, handling DST transitions automatically.
 *
 * @param etDateStr - Calendar date in `YYYY-MM-DD` format.
 * @param hour      - Hour (0–23) in ET.
 * @param minute    - Minute (0–59) in ET.
 * @returns A `Date` object at the specified ET time. Falls back to EST
 *          (UTC−5) if neither candidate validates (edge-case guard).
 */
function dateAtEtTime(etDateStr: string, hour: number, minute: number): Date {
  for (const tzOffset of ["-05:00", "-04:00"]) {
    const iso = `${etDateStr}T${pad2(hour)}:${pad2(minute)}:00${tzOffset}`;
    const candidate = new Date(iso);
    // Verify by formatting back: the ET hour must match.
    const etHour = parseInt(
      new Intl.DateTimeFormat("en-US", {
        timeZone: ET_TIMEZONE,
        hour: "2-digit",
        hour12: false,
      }).format(candidate),
      10,
    ) % 24;
    if (etHour === hour) return candidate;
  }
  // Fallback (should not be reached for 9:30 AM or 4:00 PM ET)
  return new Date(
    `${etDateStr}T${pad2(hour)}:${pad2(minute)}:00-05:00`,
  );
}

/**
 * Computes the `YYYY-MM-DD` date string of the next US business day after the
 * given ET date, skipping weekends. Does **not** account for market holidays
 * (use the `holiday` field from {@link MarketStatus} for that).
 *
 * @param etDateStr  - Current ET date in `YYYY-MM-DD` format.
 * @param etWeekday  - Day-of-week number for `etDateStr` (Sunday=0 … Saturday=6).
 * @returns `YYYY-MM-DD` string of the next weekday.
 */
function nextBusinessDateStr(etDateStr: string, etWeekday: number): string {
  const [y, m, d] = etDateStr.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  // Use a UTC date to avoid timezone shifting when adding days.
  const date = new Date(Date.UTC(y, m - 1, d));
  let daysToAdd: number;
  if (etWeekday === 5) {
    // Friday → next Monday
    daysToAdd = 3;
  } else if (etWeekday === 6) {
    // Saturday → next Monday
    daysToAdd = 2;
  } else {
    // Sun–Thu → next calendar day (Sun already guarded by phase logic)
    daysToAdd = 1;
  }
  date.setUTCDate(date.getUTCDate() + daysToAdd);
  return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${
    pad2(date.getUTCDate())
  }`;
}

/**
 * Classifies the current market phase based on `isOpen` and the ET time.
 *
 * The Finnhub `/stock/market-status` endpoint only surfaces the regular
 * session (`isOpen`). Pre-market and after-hours windows are inferred from
 * the current ET clock time when `isOpen` is false.
 *
 * Session windows (ET):
 * - Regular open: 9:30 AM – 4:00 PM (`isOpen === true`)
 * - Pre-market: 4:00 AM – 9:30 AM  (inferred when `isOpen` is false)
 * - After-hours: 4:00 PM – 8:00 PM (inferred when `isOpen` is false)
 * - Closed: outside all of the above
 *
 * @param isOpen    - Whether the regular session is currently active.
 * @param etHour    - Current ET hour (0–23).
 * @param etMinute  - Current ET minute (0–59).
 * @returns Market phase string.
 */
function classifyMarketPhase(
  isOpen: boolean,
  etHour: number,
  etMinute: number,
): "open" | "pre" | "after" | "closed" {
  if (isOpen) return "open";

  const minutesSinceMidnight = etHour * 60 + etMinute;
  const preMarketStart = PREMARKET_START_HOUR_ET * 60;
  const regularOpen = MARKET_OPEN_HOUR_ET * 60 + MARKET_OPEN_MINUTE_ET;
  const regularClose = MARKET_CLOSE_HOUR_ET * 60 + MARKET_CLOSE_MINUTE_ET;
  const afterHoursEnd = AFTERHOURS_END_HOUR_ET * 60;

  if (
    minutesSinceMidnight >= preMarketStart && minutesSinceMidnight < regularOpen
  ) {
    return "pre";
  }
  if (
    minutesSinceMidnight >= regularClose && minutesSinceMidnight < afterHoursEnd
  ) {
    return "after";
  }
  return "closed";
}

/**
 * Returns the styled badge descriptor for a given market phase.
 *
 * Colour palette follows the traffic-light convention used elsewhere in the
 * tool: green = active trading, amber = limited/extended trading, grey = closed.
 *
 * @param phase - The current market phase.
 * @returns A {@link PhaseBadge} with `label`, `background`, and `color` fields.
 */
function phaseBadge(phase: "open" | "pre" | "after" | "closed"): PhaseBadge {
  switch (phase) {
    case "open":
      return { label: "Open", background: "#dcfce7", color: "#15803d" };
    case "pre":
      return { label: "Pre-Market", background: "#fef9c3", color: "#92400e" };
    case "after":
      return { label: "After-Hours", background: "#fef9c3", color: "#92400e" };
    case "closed":
      return { label: "Closed", background: "#f3f4f6", color: "#6b7280" };
  }
}

/**
 * Computes the next scheduled market event (open or close) as a `Date` object
 * and a short English label.
 *
 * Rules:
 * - `"open"` phase  → next event is today's regular close (4:00 PM ET)
 * - `"pre"` phase   → next event is today's regular open (9:30 AM ET)
 * - `"after"` or `"closed"` → next event is next business day open (9:30 AM ET)
 *
 * Weekend and weekday transitions are handled by {@link nextBusinessDateStr}.
 * Public holiday awareness is limited — if Finnhub reports a holiday the
 * next-open label reads "Next open: 9:30 AM ET (next business day)" without
 * the specific date, to avoid inaccurate holiday calendars.
 *
 * @param phase   - Current market phase.
 * @param etParts - Decomposed ET time for the current moment.
 * @returns An object with a human-readable `label` and the corresponding
 *          `date` object, or `null` when the next event cannot be computed.
 */
function computeNextEvent(
  phase: "open" | "pre" | "after" | "closed",
  etParts: EtTimeParts,
): { label: string; date: Date } | null {
  const etDateStr = `${etParts.year}-${pad2(etParts.month)}-${
    pad2(etParts.day)
  }`;

  if (phase === "open") {
    const closeDate = dateAtEtTime(
      etDateStr,
      MARKET_CLOSE_HOUR_ET,
      MARKET_CLOSE_MINUTE_ET,
    );
    return { label: "Market closes", date: closeDate };
  }

  if (phase === "pre") {
    const openDate = dateAtEtTime(
      etDateStr,
      MARKET_OPEN_HOUR_ET,
      MARKET_OPEN_MINUTE_ET,
    );
    return { label: "Market opens", date: openDate };
  }

  // After-hours or closed: next open is the next business day.
  const weekdayNum = WEEKDAY_NUMS[etParts.weekday] ?? 1;
  const nextDate = nextBusinessDateStr(etDateStr, weekdayNum);
  const openDate = dateAtEtTime(
    nextDate,
    MARKET_OPEN_HOUR_ET,
    MARKET_OPEN_MINUTE_ET,
  );
  return { label: "Market opens", date: openDate };
}

/**
 * Formats a signed numeric price change with an explicit `+` prefix for gains
 * and a trailing `%` suffix.
 *
 * @param pct - Signed percentage value (e.g. `1.32` or `-0.61`).
 * @returns Formatted string such as `"+1.32%"` or `"-0.61%"`.
 */
function formatChangePct(pct: number): string {
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

/**
 * Returns the CSS hex colour for a signed change value.
 * Positive → green, negative → red, zero → neutral grey.
 *
 * @param value - Signed numeric value whose sign drives the colour.
 * @returns CSS hex colour string.
 */
function changeColor(value: number): string {
  if (value > 0) return "#16a34a";
  if (value < 0) return "#dc2626";
  return "#6b7280";
}

/**
 * Formats a numeric price as a localised USD currency string.
 *
 * @param price - Raw price value.
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
 * Formats a YYYY-MM-DD date string to a human-readable form (e.g. `"Jan 26"`).
 * Falls back to the raw string on parse failure.
 *
 * @param dateStr - Date in `YYYY-MM-DD` format.
 * @returns Short human-readable date string.
 */
function formatShortDate(dateStr: string): string {
  const d = new Date(`${dateStr}T12:00:00Z`);
  if (isNaN(d.getTime())) return dateStr;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(d);
}

// ---------------------------------------------------------------------------
// handleMarketStatus
// ---------------------------------------------------------------------------

/**
 * Fetches the current US market status and renders a rich HTML card.
 *
 * ### Card contents
 * - Market phase badge: Open · Pre-Market · After-Hours · Closed
 * - Current time in ET (24-hour clock)
 * - Holiday notice when `marketStatus.holiday` is non-null
 * - Index ETF summary table: SPY, QQQ, DIA with live price and % change
 *   (fetched via fresh `client.quote()` calls; shows "Data unavailable" on
 *   fetch failure or if all three fail)
 * - Next market event: close time (when open) or open time (when closed),
 *   formatted in both ET and the user's local timezone
 *
 * ### Error handling
 * The function always resolves (never rejects). A Finnhub error on the
 * market-status call returns a result with `error` set and an error card.
 * Index quote failures are handled individually — failed symbols show
 * "Data unavailable" inline rather than aborting the entire card.
 *
 * @param params  - No parameters required; pass `{}`.
 * @param client  - Configured {@link FinnhubClient} instance.
 * @param state   - Current {@link ToolState} (used for last-known market state
 *                  context; not mutated by this function).
 * @returns A resolved {@link CapabilityResult} — never rejects.
 *
 * @example
 * ```ts
 * const result = await handleMarketStatus({}, client, state);
 * console.log(result.text); // "Market: Open | 2:45 PM ET | SPY $523.14 +0.32% …"
 * ```
 */
export async function handleMarketStatus(
  _params: Record<string, never>,
  client: FinnhubClient,
  _state: ToolState,
): Promise<CapabilityResult> {
  // ── 1. Fetch market status ──────────────────────────────────────────────
  let isOpen = false;
  let holiday: string | null = null;

  try {
    const status = await client.marketStatus("US");
    isOpen = status.isOpen;
    holiday = status.holiday;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const html = `
<div style="font-family:system-ui,sans-serif;background:#fff;border:1px solid #fecaca;
    border-radius:8px;padding:16px;max-width:520px">
  <p style="margin:0;color:#dc2626;font-size:14px">
    <strong>Error fetching market status:</strong> ${escapeHtml(msg)}
  </p>
</div>`.trim();
    return { text: `Error fetching market status: ${msg}`, html, error: msg };
  }

  // ── 2. Compute ET time and market phase ───────────────────────────────────
  const now = new Date();
  const etParts = getEtTimeParts(now);
  const phase = classifyMarketPhase(isOpen, etParts.hour, etParts.minute);
  const badge = phaseBadge(phase);

  // Human-readable ET time string (e.g. "2:45 PM")
  const etTimeStr = new Intl.DateTimeFormat("en-US", {
    timeZone: ET_TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(now);

  // ── 3. Fetch index ETF quotes (best-effort, per-symbol fallback) ──────────
  const quoteResults = await Promise.allSettled(
    INDEX_SYMBOLS.map((sym) => client.quote(sym)),
  );

  /** Resolved quote or null on failure, indexed by position in INDEX_SYMBOLS. */
  const quotes: (Quote | null)[] = quoteResults.map((r) =>
    r.status === "fulfilled" ? r.value : null
  );

  // ── 4. Compute next market event ─────────────────────────────────────────
  const nextEvent = computeNextEvent(phase, etParts);

  // ── 5. Build plain-text summary ──────────────────────────────────────────
  const indexText = INDEX_SYMBOLS.map((sym, i) => {
    const q = quotes[i];
    if (q === null) return `${sym}: N/A`;
    return `${sym} ${formatPrice(q.price)} ${formatChangePct(q.changePercent)}`;
  }).join(" | ");

  const nextEventText = nextEvent
    ? `${nextEvent.label} at ${formatEtTime(nextEvent.date)} (${
      formatLocalDateTime(nextEvent.date)
    } local)`
    : "";

  const phaseLabel = phase === "open"
    ? "Open"
    : phase === "pre"
    ? "Pre-Market"
    : phase === "after"
    ? "After-Hours"
    : "Closed";

  const text = [
    `Market: ${phaseLabel} | ${etTimeStr} ET`,
    holiday !== null ? `Holiday: ${holiday}` : null,
    indexText,
    nextEventText !== "" ? nextEventText : null,
  ]
    .filter(Boolean)
    .join(" | ");

  // ── 6. Build HTML card ────────────────────────────────────────────────────

  // Holiday banner (only shown when a holiday is active)
  const holidayBanner = holiday !== null
    ? `
  <div style="background:#fef9c3;border-radius:4px;padding:8px 12px;
      margin-bottom:12px;font-size:13px;color:#92400e">
    🗓 Market closed for <strong>${escapeHtml(holiday)}</strong>
  </div>`
    : "";

  // Index summary rows
  const indexRows = INDEX_SYMBOLS.map((sym, i) => {
    const q = quotes[i];
    const name = escapeHtml(INDEX_NAMES[sym] ?? sym);
    if (q === null) {
      return `
      <tr style="border-top:1px solid #f3f4f6">
        <td style="padding:7px 4px;font-size:13px;color:#374151">${name}</td>
        <td style="padding:7px 4px;font-size:13px;color:#9ca3af;text-align:right" colspan="2">
          Data unavailable
        </td>
      </tr>`;
    }
    const color = changeColor(q.changePercent);
    return `
      <tr style="border-top:1px solid #f3f4f6">
        <td style="padding:7px 4px;font-size:13px;color:#374151">${name}</td>
        <td style="padding:7px 4px;font-size:13px;font-weight:600;text-align:right">
          ${formatPrice(q.price)}
        </td>
        <td style="padding:7px 4px;font-size:13px;font-weight:600;
            color:${color};text-align:right">
          ${escapeHtml(formatChangePct(q.changePercent))}
        </td>
      </tr>`;
  }).join("");

  // Next event footer
  const nextEventHtml = nextEvent
    ? `
  <div style="margin-top:12px;padding-top:10px;border-top:1px solid #f3f4f6;
      font-size:12px;color:#6b7280">
    ${escapeHtml(nextEvent.label)}:
    <strong style="color:#374151">${
      escapeHtml(formatEtTime(nextEvent.date))
    }</strong>
    <span style="color:#9ca3af"> · ${
      escapeHtml(formatLocalDateTime(nextEvent.date))
    } (local)</span>
  </div>`
    : "";

  const html = `
<div style="font-family:system-ui,sans-serif;background:#fff;border:1px solid #e5e7eb;
    border-radius:8px;padding:16px;max-width:520px;
    box-shadow:0 1px 3px rgba(0,0,0,0.08)">

  <!-- Header: title + phase badge -->
  <div style="display:flex;justify-content:space-between;align-items:center;
      margin-bottom:12px">
    <span style="font-size:16px;font-weight:700;color:#111827">
      US Market Status
    </span>
    <span style="font-size:11px;font-weight:700;padding:3px 10px;border-radius:12px;
        white-space:nowrap;background:${badge.background};color:${badge.color}">
      ${escapeHtml(badge.label)}
    </span>
  </div>

  <!-- Current ET time -->
  <div style="font-size:13px;color:#6b7280;margin-bottom:12px">
    Current time: <strong style="color:#374151">${
    escapeHtml(etTimeStr)
  } ET</strong>
  </div>

  ${holidayBanner}

  <!-- Index summary table -->
  <table style="width:100%;border-collapse:collapse">
    <thead>
      <tr>
        <th style="text-align:left;font-size:11px;font-weight:600;
            color:#9ca3af;padding-bottom:4px">INDEX</th>
        <th style="text-align:right;font-size:11px;font-weight:600;
            color:#9ca3af;padding-bottom:4px">PRICE</th>
        <th style="text-align:right;font-size:11px;font-weight:600;
            color:#9ca3af;padding-bottom:4px">CHANGE</th>
      </tr>
    </thead>
    <tbody>${indexRows}
    </tbody>
  </table>

  ${nextEventHtml}
</div>`.trim();

  return { text, html };
}

// ---------------------------------------------------------------------------
// handleEarningsCalendar
// ---------------------------------------------------------------------------

/**
 * Fetches upcoming earnings events and renders a rich HTML card.
 *
 * ### Card contents
 * - One row per earnings event: symbol, report date, pre/post-market timing,
 *   estimated EPS, and actual EPS (if already reported)
 * - Filtered to `params.symbol` when supplied
 * - An "empty state" message when no earnings are scheduled in the window
 *
 * ### Finnhub endpoint
 * `GET /calendar/earnings?from=YYYY-MM-DD&to=YYYY-MM-DD[&symbol=XXXX]`
 *
 * The `from` date is today's ET date; `to` is today + `daysAhead` calendar
 * days. Both dates are derived from the current ET clock rather than UTC to
 * align with the US market calendar.
 *
 * ### Error handling
 * Always resolves. On API error the result has `error` set and the `html`
 * field shows a user-friendly error message.
 *
 * @param params            - Handler parameters.
 * @param params.symbol     - Optional ticker to filter to (case-insensitive).
 *   When absent, all symbols with earnings in the window are shown.
 * @param params.daysAhead  - Number of calendar days ahead to include
 *   (default: `7`; minimum: `1`; maximum: `30` to limit result size).
 * @param client            - Configured {@link FinnhubClient} instance.
 * @param _state            - Current {@link ToolState} (unused; included for
 *   handler-signature consistency).
 * @returns A resolved {@link CapabilityResult} — never rejects.
 *
 * @example
 * ```ts
 * const result = await handleEarningsCalendar({ symbol: "AAPL", daysAhead: 14 }, client, state);
 * console.log(result.text);
 * // "Upcoming earnings (next 14 days): AAPL — Jan 26 · After Close · Est. EPS: $1.94"
 * ```
 */
export async function handleEarningsCalendar(
  params: { symbol?: string; daysAhead?: number },
  client: FinnhubClient,
  _state: ToolState,
): Promise<CapabilityResult> {
  // ── 1. Resolve parameters ─────────────────────────────────────────────────
  const symbolFilter =
    typeof params.symbol === "string" && params.symbol.trim().length > 0
      ? params.symbol.trim().toUpperCase()
      : undefined;

  const rawDays = params.daysAhead ?? 7;
  const daysAhead = Math.max(1, Math.min(30, Math.floor(rawDays)));

  // ── 2. Compute date range in ET ───────────────────────────────────────────
  const now = new Date();
  const etParts = getEtTimeParts(now);
  const fromStr = `${etParts.year}-${pad2(etParts.month)}-${pad2(etParts.day)}`;

  // Add daysAhead calendar days using UTC arithmetic to avoid DST shifts.
  const toDate = new Date(
    Date.UTC(etParts.year, etParts.month - 1, etParts.day + daysAhead),
  );
  const toStr = `${toDate.getUTCFullYear()}-${pad2(toDate.getUTCMonth() + 1)}-${
    pad2(toDate.getUTCDate())
  }`;

  // ── 3. Fetch earnings calendar ────────────────────────────────────────────
  let entries: EarningsEntry[];
  try {
    entries = await client.earningsCalendar(fromStr, toStr, symbolFilter);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const html = `
<div style="font-family:system-ui,sans-serif;background:#fff;border:1px solid #fecaca;
    border-radius:8px;padding:16px;max-width:600px">
  <p style="margin:0;color:#dc2626;font-size:14px">
    <strong>Error fetching earnings calendar:</strong> ${escapeHtml(msg)}
  </p>
</div>`.trim();
    return {
      text: `Error fetching earnings calendar: ${msg}`,
      html,
      error: msg,
    };
  }

  // ── 4. Sort by date (ascending) ───────────────────────────────────────────
  const sorted = [...entries].sort((a, b) => a.date.localeCompare(b.date));

  // ── 5. Compute heading ────────────────────────────────────────────────────
  const heading = symbolFilter !== undefined
    ? `Earnings for ${symbolFilter} (next ${daysAhead} day${
      daysAhead !== 1 ? "s" : ""
    })`
    : `Upcoming Earnings — Next ${daysAhead} Day${daysAhead !== 1 ? "s" : ""}`;

  // ── 6. Build plain-text summary ───────────────────────────────────────────
  const text = sorted.length === 0
    ? `${heading}: No earnings scheduled.`
    : `${heading}: ` +
      sorted
        .slice(0, 10)
        .map((e) => {
          const timing = reportTimeLabel(e.reportTime);
          const eps = e.epsEstimate !== null
            ? `Est. EPS: $${e.epsEstimate.toFixed(2)}`
            : "Est. EPS: N/A";
          return `${e.symbol} — ${
            formatShortDate(e.date)
          } · ${timing} · ${eps}`;
        })
        .join("; ");

  // ── 7. Build HTML card ────────────────────────────────────────────────────

  // Empty-state card
  if (sorted.length === 0) {
    const html = `
<div style="font-family:system-ui,sans-serif;background:#fff;border:1px solid #e5e7eb;
    border-radius:8px;padding:16px;max-width:600px;
    box-shadow:0 1px 3px rgba(0,0,0,0.08)">
  <div style="font-size:15px;font-weight:700;color:#111827;margin-bottom:12px">
    ${escapeHtml(heading)}
  </div>
  <p style="margin:0;font-size:13px;color:#6b7280">
    No earnings scheduled in this window.
  </p>
</div>`.trim();
    return { text, html };
  }

  // Table rows
  const rows = sorted
    .map((e) => {
      const timing = reportTimeLabel(e.reportTime);
      const timingColor = reportTimeColor(e.reportTime);
      const epsEstStr = e.epsEstimate !== null
        ? `$${e.epsEstimate.toFixed(2)}`
        : "N/A";
      const epsActStr = e.epsActual !== null
        ? `$${e.epsActual.toFixed(2)}`
        : "—";

      return `
      <tr style="border-top:1px solid #f3f4f6">
        <td style="padding:8px 6px;font-size:13px;font-weight:600;color:#111827">
          ${escapeHtml(e.symbol)}
        </td>
        <td style="padding:8px 6px;font-size:13px;color:#374151">
          ${escapeHtml(formatShortDate(e.date))}
        </td>
        <td style="padding:8px 6px;font-size:11px;font-weight:600;white-space:nowrap;
            color:${timingColor}">
          ${escapeHtml(timing)}
        </td>
        <td style="padding:8px 6px;font-size:13px;color:#374151;text-align:right">
          ${escapeHtml(epsEstStr)}
        </td>
        <td style="padding:8px 6px;font-size:13px;color:#374151;text-align:right">
          ${escapeHtml(epsActStr)}
        </td>
      </tr>`;
    })
    .join("");

  const html = `
<div style="font-family:system-ui,sans-serif;background:#fff;border:1px solid #e5e7eb;
    border-radius:8px;padding:16px;max-width:600px;
    box-shadow:0 1px 3px rgba(0,0,0,0.08)">

  <!-- Header -->
  <div style="font-size:15px;font-weight:700;color:#111827;margin-bottom:12px">
    ${escapeHtml(heading)}
  </div>

  <!-- Earnings table -->
  <table style="width:100%;border-collapse:collapse">
    <thead>
      <tr>
        <th style="text-align:left;font-size:11px;font-weight:600;
            color:#9ca3af;padding-bottom:6px">SYMBOL</th>
        <th style="text-align:left;font-size:11px;font-weight:600;
            color:#9ca3af;padding-bottom:6px">DATE</th>
        <th style="text-align:left;font-size:11px;font-weight:600;
            color:#9ca3af;padding-bottom:6px">TIMING</th>
        <th style="text-align:right;font-size:11px;font-weight:600;
            color:#9ca3af;padding-bottom:6px">EST. EPS</th>
        <th style="text-align:right;font-size:11px;font-weight:600;
            color:#9ca3af;padding-bottom:6px">ACT. EPS</th>
      </tr>
    </thead>
    <tbody>${rows}
    </tbody>
  </table>

  <p style="margin:12px 0 0;font-size:11px;color:#9ca3af">
    EPS estimates from Finnhub · Dates in ET · Free-tier data may be incomplete
  </p>
</div>`.trim();

  return { text, html };
}

// ---------------------------------------------------------------------------
// Internal helpers for earnings display
// ---------------------------------------------------------------------------

/**
 * Returns a short human-readable label for an earnings report timing value.
 *
 * @param reportTime - The {@link EarningsEntry.reportTime} classification.
 * @returns Display label suitable for UI rendering.
 */
function reportTimeLabel(
  reportTime: EarningsEntry["reportTime"],
): string {
  switch (reportTime) {
    case "before-open":
      return "Before Open";
    case "after-close":
      return "After Close";
    case "during-hours":
      return "During Hours";
    case "unknown":
      return "Time TBD";
  }
}

/**
 * Returns a CSS colour for the earnings report timing chip.
 *
 * Colour semantics:
 * - Before Open / After Close: amber (extended-hours context)
 * - During Hours: green (regular session)
 * - Unknown: grey
 *
 * @param reportTime - The {@link EarningsEntry.reportTime} classification.
 * @returns CSS hex colour string.
 */
function reportTimeColor(
  reportTime: EarningsEntry["reportTime"],
): string {
  switch (reportTime) {
    case "before-open":
    case "after-close":
      return "#92400e";
    case "during-hours":
      return "#15803d";
    case "unknown":
      return "#6b7280";
  }
}
