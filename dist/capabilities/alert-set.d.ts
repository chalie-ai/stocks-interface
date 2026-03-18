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
import type { ToolState } from "../finnhub/types.js";
import type { CapabilityResult } from "./stock-quote.js";
/**
 * Parameters for {@link handleAlertSet}.
 */
export interface AlertSetParams {
    /** Ticker symbol to monitor (case-insensitive; normalised to upper-case). */
    symbol: string;
    /** Price threshold in USD (or the symbol's native currency). */
    targetPrice: number;
    /**
     * Direction of the price crossing.
     * - `"above"` — fires when `price >= targetPrice`.
     * - `"below"` — fires when `price <= targetPrice`.
     */
    direction: "above" | "below";
    /**
     * Optional custom note appended to the generated alert notification.
     * Stored as-is in {@link PriceAlert.message}.
     */
    message?: string;
}
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
export declare function handleAlertSet(params: AlertSetParams, state: ToolState): {
    result: CapabilityResult;
    updatedState: ToolState;
};
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
export declare function handleAlertList(_params: Record<string, never>, state: ToolState): CapabilityResult;
/**
 * Parameters for {@link handleAlertDelete}.
 */
export interface AlertDeleteParams {
    /** The unique `id` of the alert to remove (full UUID or prefix). */
    alertId: string;
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
export declare function handleAlertDelete(params: AlertDeleteParams, state: ToolState): {
    result: CapabilityResult;
    updatedState: ToolState;
};
//# sourceMappingURL=alert-set.d.ts.map