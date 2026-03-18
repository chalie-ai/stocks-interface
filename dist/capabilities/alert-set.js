/**
 * @file src/capabilities/alert-set.ts
 * @description Capability handlers for price alert management.
 *
 * Exposes three handlers consumed by the Chalie reasoning layer:
 *  - {@link handleAlertSet}    — create a new price threshold alert
 *  - {@link handleAlertList}   — list all active (and recently triggered) alerts
 *  - {@link handleAlertDelete} — delete an alert by its unique ID
 *
 * ## State contract
 * All handlers accept the current {@link ToolState} and return a
 * `{ result: CapabilityResult, updatedState: ToolState }` pair (or just
 * `CapabilityResult` for read-only operations). The input `state` is never
 * mutated; a new object is returned. Callers must persist `updatedState` via
 * `saveState()`.
 *
 * ## Delivery contract
 * Alert creation and deletion are synchronous operations that do not require a
 * Finnhub API call. The live price is therefore not available at creation time;
 * the confirmation message omits it. When a created alert actually fires, the
 * triggered-alert message (produced by {@link formatAlertMessage} in
 * `sync/alerts.ts`) includes the live price at that point.
 *
 * @module stocks-interface/capabilities/alert-set
 */
import { createAlert, deleteAlert, } from "../sync/alerts.js";
/**
 * Creates a new price threshold alert for a symbol that is already on the
 * user's watchlist.
 *
 * ### Validation
 * The symbol must be present in `state.watchlist` (case-insensitive). If it is
 * not, the function returns an error result and leaves `state` unchanged. This
 * ensures the sync layer always has live quote data for the alerted symbol —
 * alerts on unwatched symbols would never fire.
 *
 * ### No live-price lookup
 * Unlike {@link handleWatchlistAdd}, this handler does not call Finnhub. The
 * confirmation message therefore does not include "Currently at …". When the
 * alert actually fires, {@link formatAlertMessage} (in `sync/alerts.ts`)
 * includes the live price.
 *
 * @param params        - Alert configuration (symbol, target, direction, optional message).
 * @param state         - Current {@link ToolState}; `watchlist` is checked for the symbol.
 * @returns An object containing:
 *   - `result`       — {@link CapabilityResult} with `text` + `html` confirmation.
 *   - `updatedState` — State with the new alert appended to `priceAlerts`.
 *     On error, `updatedState` equals the input `state` unchanged.
 *
 * @example
 * ```ts
 * const { result, updatedState } = handleAlertSet(
 *   { symbol: "AAPL", targetPrice: 200, direction: "above" },
 *   state,
 * );
 * await saveState(dataDir, updatedState);
 * ```
 */
export function handleAlertSet(params, state) {
    const symbol = params.symbol.toUpperCase().trim();
    // ── Validate: symbol must be on the watchlist ────────────────────────────
    const watchlistItem = state.watchlist.find((item) => item.symbol.toUpperCase() === symbol);
    if (watchlistItem === undefined) {
        return buildErrorResult(`${symbol} is not in your watchlist. Add it first before setting a price alert.`, state);
    }
    // ── Create the alert ─────────────────────────────────────────────────────
    const updatedState = createAlert(state, symbol, params.targetPrice, params.direction, params.message ?? "");
    // ── Build confirmation copy ───────────────────────────────────────────────
    const directionWord = params.direction === "above" ? "above" : "below";
    const targetFormatted = formatPrice(params.targetPrice);
    const displayName = watchlistItem.name !== symbol ? ` (${watchlistItem.name})` : "";
    const customNote = params.message && params.message.trim().length > 0
        ? ` Note: "${params.message.trim()}".`
        : "";
    const text = `Alert set: notify me when ${symbol}${displayName} crosses ${directionWord} ` +
        `${targetFormatted}.${customNote}`;
    const html = buildAlertSetHtml(symbol, watchlistItem.name, params.direction, params.targetPrice, params.message ?? "");
    return { result: { text, html }, updatedState };
}
// ---------------------------------------------------------------------------
// handleAlertList
// ---------------------------------------------------------------------------
/**
 * Returns a {@link CapabilityResult} listing all price alerts stored in state.
 *
 * The HTML response is an inline-CSS table with columns:
 * ID (truncated), Symbol, Direction, Target Price, Created, and Status.
 * Triggered (inactive) alerts are shown with a muted style so the user can
 * distinguish live alerts from historical ones.
 *
 * When `state.priceAlerts` is empty the response contains the text
 * "No active alerts." with a matching HTML message.
 *
 * @param _params - Unused. Accepted to keep all handlers consistent in shape.
 * @param state   - Current {@link ToolState}; `priceAlerts` is read from here.
 * @returns A {@link CapabilityResult} with `text` and `html` representations
 *   of the full alert list. Never returns an `error` field.
 *
 * @example
 * ```ts
 * const result = handleAlertList({}, state);
 * // result.html contains a styled table of price alerts
 * ```
 */
export function handleAlertList(_params, state) {
    const alerts = state.priceAlerts;
    if (alerts.length === 0) {
        const text = "No active alerts.";
        const html = `
<div style="font-family:system-ui,sans-serif;background:#fff;border:1px solid #e5e7eb;
    border-radius:8px;padding:16px;max-width:560px">
  <p style="margin:0;color:#6b7280;font-size:14px">No active alerts.</p>
</div>`.trim();
        return { text, html };
    }
    // ── Build plain-text summary ──────────────────────────────────────────────
    const lines = alerts.map((a) => {
        const status = a.active ? "active" : `triggered ${a.triggeredAt ?? ""}`;
        return `${a.id.slice(0, 8)} | ${a.symbol} | ${a.direction} ${formatPrice(a.targetPrice)} | created ${formatDate(a.createdAt)} | ${status}`;
    });
    const text = `Price alerts (${alerts.length}):\n` + lines.join("\n");
    // ── Build HTML table ──────────────────────────────────────────────────────
    const rows = alerts
        .map((a) => buildAlertTableRow(a))
        .join("\n");
    const html = `
<div style="font-family:system-ui,sans-serif;background:#fff;border:1px solid #e5e7eb;
    border-radius:8px;padding:16px;max-width:680px;overflow-x:auto">

  <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
    <span style="font-size:15px">🔔</span>
    <span style="font-size:15px;font-weight:700;color:#111827">
      Price Alerts (${alerts.length})
    </span>
  </div>

  <table style="width:100%;border-collapse:collapse;font-size:13px;color:#374151">
    <thead>
      <tr style="background:#f9fafb">
        <th style="padding:7px 8px;text-align:left;font-weight:600;color:#6b7280;border-bottom:1px solid #e5e7eb">ID</th>
        <th style="padding:7px 8px;text-align:left;font-weight:600;color:#6b7280;border-bottom:1px solid #e5e7eb">Symbol</th>
        <th style="padding:7px 8px;text-align:left;font-weight:600;color:#6b7280;border-bottom:1px solid #e5e7eb">Direction</th>
        <th style="padding:7px 8px;text-align:right;font-weight:600;color:#6b7280;border-bottom:1px solid #e5e7eb">Target Price</th>
        <th style="padding:7px 8px;text-align:left;font-weight:600;color:#6b7280;border-bottom:1px solid #e5e7eb">Created</th>
        <th style="padding:7px 8px;text-align:left;font-weight:600;color:#6b7280;border-bottom:1px solid #e5e7eb">Status</th>
      </tr>
    </thead>
    <tbody>
      ${rows}
    </tbody>
  </table>
</div>`.trim();
    return { text, html };
}
/**
 * Removes a price alert from `state.priceAlerts` by its unique ID.
 *
 * ### Not-found behaviour
 * If no alert with `alertId` exists in state, the function returns an error
 * {@link CapabilityResult} and leaves `state` unchanged. This prevents silent
 * no-ops that could confuse the user.
 *
 * The input `state` is never mutated; a new object is returned.
 *
 * @param params          - Parameters containing the alert ID to delete.
 * @param params.alertId  - Full UUID of the alert to remove (as shown by
 *   {@link handleAlertList}).
 * @param state           - Current {@link ToolState}; `priceAlerts` is searched for `alertId`.
 * @returns An object containing:
 *   - `result`       — {@link CapabilityResult} confirming deletion, or error if not found.
 *   - `updatedState` — State with the alert removed (or unchanged state on error).
 *
 * @example
 * ```ts
 * const { result, updatedState } = handleAlertDelete(
 *   { alertId: "f47ac10b-58cc-4372-a567-0e02b2c3d479" },
 *   state,
 * );
 * await saveState(dataDir, updatedState);
 * ```
 */
export function handleAlertDelete(params, state) {
    const alertId = params.alertId.trim();
    // ── Validate: alert must exist ───────────────────────────────────────────
    const existingAlert = state.priceAlerts.find((a) => a.id === alertId);
    if (existingAlert === undefined) {
        return buildErrorResult(`No alert with ID "${alertId}" was found. Use the alert list to find the correct ID.`, state);
    }
    // ── Delete via sync/alerts helper ─────────────────────────────────────────
    const updatedState = deleteAlert(state, alertId);
    // ── Build confirmation copy ───────────────────────────────────────────────
    const directionWord = existingAlert.direction === "above" ? "above" : "below";
    const targetFormatted = formatPrice(existingAlert.targetPrice);
    const text = `Alert deleted: ${existingAlert.symbol} ${directionWord} ${targetFormatted} ` +
        `(ID: ${alertId.slice(0, 8)}…).`;
    const html = buildAlertDeleteHtml(existingAlert);
    return { result: { text, html }, updatedState };
}
// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------
/**
 * Builds a standardised error {@link CapabilityResult} paired with the
 * unchanged input state.
 *
 * @param message - Human-readable error message displayed to the user.
 * @param state   - The unchanged input state returned as `updatedState`.
 * @returns `{ result, updatedState }` where `result.error` is set.
 */
function buildErrorResult(message, state) {
    const html = `
<div style="font-family:system-ui,sans-serif;background:#fff;border:1px solid #fecaca;
    border-radius:8px;padding:16px;max-width:480px">
  <p style="margin:0;color:#dc2626;font-size:14px">
    ${escapeHtml(message)}
  </p>
</div>`.trim();
    return {
        result: { text: message, html, error: message },
        updatedState: state,
    };
}
/**
 * Builds the success HTML card shown after an alert is created.
 *
 * @param symbol      - Uppercase ticker symbol being monitored.
 * @param displayName - Human-readable name of the symbol.
 * @param direction   - Crossing direction (`"above"` or `"below"`).
 * @param targetPrice - Numeric price threshold.
 * @param customNote  - Optional user-supplied note (may be empty string).
 * @returns An inline-CSS HTML fragment safe for rendering in the Chalie UI.
 */
function buildAlertSetHtml(symbol, displayName, direction, targetPrice, customNote) {
    const directionWord = direction === "above" ? "above" : "below";
    const directionColor = direction === "above" ? "#15803d" : "#dc2626";
    const directionBg = direction === "above" ? "rgba(21,128,61,0.08)" : "rgba(220,38,38,0.08)";
    const noteRow = customNote.trim().length > 0
        ? `<tr style="border-top:1px solid #f0fdf4">
           <td style="padding:5px 4px;color:#6b7280;width:120px">Note</td>
           <td style="padding:5px 4px;font-weight:500">${escapeHtml(customNote.trim())}</td>
         </tr>`
        : "";
    return `
<div style="font-family:system-ui,sans-serif;background:#fff;border:1px solid #bbf7d0;
    border-radius:8px;padding:16px;max-width:480px;
    box-shadow:0 1px 3px rgba(0,0,0,0.06)">

  <!-- Header -->
  <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
    <span style="font-size:16px">🔔</span>
    <span style="font-size:15px;font-weight:700;color:#15803d">
      Alert set for ${escapeHtml(symbol)}
    </span>
    <span style="font-size:11px;font-weight:600;padding:2px 7px;border-radius:10px;
           background:${directionBg};color:${directionColor};margin-left:4px">
      ${directionWord.toUpperCase()}
    </span>
  </div>

  <!-- Detail rows -->
  <table style="width:100%;border-collapse:collapse;font-size:13px;color:#374151">
    <tbody>
      <tr style="border-top:1px solid #f0fdf4">
        <td style="padding:5px 4px;color:#6b7280;width:120px">Symbol</td>
        <td style="padding:5px 4px;font-weight:500">${escapeHtml(symbol)} · ${escapeHtml(displayName)}</td>
      </tr>
      <tr style="border-top:1px solid #f0fdf4">
        <td style="padding:5px 4px;color:#6b7280">Condition</td>
        <td style="padding:5px 4px;font-weight:500">Price crosses ${escapeHtml(directionWord)} ${escapeHtml(formatPrice(targetPrice))}</td>
      </tr>
      ${noteRow}
    </tbody>
  </table>
</div>`.trim();
}
/**
 * Builds a single `<tr>` for the alert-list table.
 *
 * Active alerts are rendered with normal weight; triggered (inactive) alerts
 * use a muted grey style to distinguish historical entries at a glance.
 *
 * @param alert - The {@link PriceAlert} to render.
 * @returns An HTML `<tr>…</tr>` string with inline styles.
 */
function buildAlertTableRow(alert) {
    const isActive = alert.active;
    const rowStyle = isActive
        ? "color:#374151"
        : "color:#9ca3af;text-decoration:line-through";
    const statusBadge = isActive
        ? `<span style="font-size:11px;font-weight:600;padding:2px 7px;border-radius:10px;
           background:rgba(21,128,61,0.10);color:#15803d">ACTIVE</span>`
        : `<span style="font-size:11px;font-weight:600;padding:2px 7px;border-radius:10px;
           background:rgba(107,114,128,0.10);color:#6b7280">TRIGGERED</span>`;
    const directionColor = alert.direction === "above" ? "#15803d" : "#dc2626";
    return `
    <tr style="border-top:1px solid #f3f4f6;${rowStyle}">
      <td style="padding:6px 8px;font-family:monospace;font-size:12px">${escapeHtml(alert.id.slice(0, 8))}…</td>
      <td style="padding:6px 8px;font-weight:600">${escapeHtml(alert.symbol)}</td>
      <td style="padding:6px 8px;font-weight:500;color:${directionColor}">${escapeHtml(alert.direction)}</td>
      <td style="padding:6px 8px;text-align:right;font-weight:500">${escapeHtml(formatPrice(alert.targetPrice))}</td>
      <td style="padding:6px 8px">${escapeHtml(formatDate(alert.createdAt))}</td>
      <td style="padding:6px 8px">${statusBadge}</td>
    </tr>`.trim();
}
/**
 * Builds the confirmation HTML card shown after an alert is deleted.
 *
 * @param alert - The {@link PriceAlert} that was deleted.
 * @returns An inline-CSS HTML fragment safe for rendering in the Chalie UI.
 */
function buildAlertDeleteHtml(alert) {
    const directionWord = alert.direction === "above" ? "above" : "below";
    return `
<div style="font-family:system-ui,sans-serif;background:#fff;border:1px solid #e5e7eb;
    border-radius:8px;padding:16px;max-width:480px;
    box-shadow:0 1px 3px rgba(0,0,0,0.06)">

  <!-- Header -->
  <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
    <span style="font-size:16px">🗑️</span>
    <span style="font-size:15px;font-weight:700;color:#374151">
      Alert deleted
    </span>
  </div>

  <!-- Detail rows -->
  <table style="width:100%;border-collapse:collapse;font-size:13px;color:#6b7280">
    <tbody>
      <tr style="border-top:1px solid #f3f4f6">
        <td style="padding:5px 4px;width:120px">Symbol</td>
        <td style="padding:5px 4px">${escapeHtml(alert.symbol)}</td>
      </tr>
      <tr style="border-top:1px solid #f3f4f6">
        <td style="padding:5px 4px">Condition</td>
        <td style="padding:5px 4px">Price ${escapeHtml(directionWord)} ${escapeHtml(formatPrice(alert.targetPrice))}</td>
      </tr>
      <tr style="border-top:1px solid #f3f4f6">
        <td style="padding:5px 4px">Alert ID</td>
        <td style="padding:5px 4px;font-family:monospace;font-size:12px">${escapeHtml(alert.id)}</td>
      </tr>
    </tbody>
  </table>
</div>`.trim();
}
/**
 * Formats a numeric price as a USD string with two decimal places.
 *
 * @param price - The numeric price value.
 * @returns A string like `"$201.30"`.
 */
function formatPrice(price) {
    return `$${price.toFixed(2)}`;
}
/**
 * Formats an ISO 8601 datetime string as a short, human-readable date.
 *
 * @param iso - ISO 8601 datetime string (e.g. `"2026-03-15T14:30:00.000Z"`).
 * @returns A short date string like `"Mar 15, 2026"`, or the raw input on
 *   parse failure.
 */
function formatDate(iso) {
    try {
        return new Date(iso).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
            year: "numeric",
        });
    }
    catch {
        return iso;
    }
}
/**
 * Escapes a string for safe interpolation into an HTML text node or attribute.
 *
 * @param str - Raw string to escape.
 * @returns HTML-safe string with `&`, `<`, `>`, `"`, and `'` replaced by
 *   their named HTML entity equivalents.
 */
function escapeHtml(str) {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
//# sourceMappingURL=alert-set.js.map