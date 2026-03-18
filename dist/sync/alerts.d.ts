/**
 * @file src/sync/alerts.ts
 * @description Price alert management and triggering for the stocks-interface tool.
 *
 * This module compares live {@link Quote} prices against user-configured
 * {@link PriceAlert} thresholds on each sync cycle, fires triggered alerts,
 * and provides CRUD helpers for managing the alert list within {@link ToolState}.
 *
 * ## IPC delivery contract
 * Price alerts are **not** delivered as background signals (energy-based queue).
 * Instead, triggered alerts are injected into Chalie's priority reasoning queue
 * via the tool-contract `output: "prompt"` + `priority: "high"` mechanism. This
 * ensures the user receives immediate feedback when a price threshold is crossed,
 * matching the urgency of a user-initiated message.
 *
 * Callers that consume the return value of {@link checkAlerts} are responsible
 * for forwarding each {@link TriggeredAlert} to the IPC layer:
 * ```ts
 * // Example IPC injection at the call site (in daemon.ts or similar):
 * //
 * // {
 * //   type: "output",
 * //   output: "prompt",          // inject into prompt/priority queue
 * //   priority: "high",          // route to reasoning:priority, not signals
 * //   content: formatAlertMessage(alert, quote),
 * // }
 * ```
 *
 * @module stocks-interface/sync/alerts
 */
import type { PriceAlert, Quote, ToolState } from "../finnhub/types.js";
/**
 * A {@link PriceAlert} that has just been triggered.
 *
 * Narrows the base type so callers receive compile-time assurance that
 * `triggeredAt` is a non-null string and `active` is `false` — both of which
 * {@link checkAlerts} guarantees for every alert in the `triggered` array.
 */
export type TriggeredAlert = PriceAlert & {
    /** ISO 8601 datetime string of when the alert fired (never null). */
    triggeredAt: string;
    /** Always `false` — the alert is deactivated on trigger. */
    active: false;
};
/**
 * Result returned by {@link checkAlerts}.
 */
export interface CheckAlertsResult {
    /**
     * Alerts that fired during this evaluation.
     *
     * Each entry is a mutated copy of the original {@link PriceAlert} with
     * `triggeredAt` set to the current ISO timestamp and `active` set to `false`.
     * Callers should forward these to the IPC layer for prompt injection
     * (see module-level JSDoc for the injection contract).
     */
    triggered: TriggeredAlert[];
    /**
     * A new {@link ToolState} with all triggered alerts marked inactive.
     *
     * The original `state` argument is **not** mutated. Callers must replace
     * their reference with `updatedState` and persist it to disk.
     */
    updatedState: ToolState;
}
/**
 * Evaluates every active {@link PriceAlert} in `state` against the provided
 * live quotes and returns alerts whose price threshold has been crossed.
 *
 * ### Crossing semantics
 * - `direction: "above"` — fires when `quote.price >= alert.targetPrice`.
 * - `direction: "below"` — fires when `quote.price <= alert.targetPrice`.
 *
 * Inactive alerts (`active: false`) are skipped unconditionally. Alerts for
 * symbols absent from `quotes` are also skipped (no quote data available).
 *
 * ### State mutation
 * Each triggered alert is stamped with `triggeredAt = new Date().toISOString()`
 * and `active = false` **in the returned `updatedState`**. The input `state`
 * is never mutated directly.
 *
 * ### IPC delivery (see module-level JSDoc)
 * Callers must inject triggered alerts into the `output: "prompt"` +
 * `priority: "high"` IPC channel. This function only returns what fired —
 * it does not perform the injection itself.
 *
 * @param state  - Current tool state containing the `priceAlerts` array.
 * @param quotes - Map of symbol → live quote, keyed by uppercase ticker symbol.
 * @returns An object with the list of triggered alerts and the updated state.
 *
 * @example
 * ```ts
 * const { triggered, updatedState } = checkAlerts(state, quotes);
 * for (const alert of triggered) {
 *   const quote = quotes.get(alert.symbol)!;
 *   ipc.send({ type: "output", output: "prompt", priority: "high",
 *               content: formatAlertMessage(alert, quote) });
 * }
 * await saveState(dataDir, updatedState);
 * ```
 */
export declare function checkAlerts(state: ToolState, quotes: Map<string, Quote>): CheckAlertsResult;
/**
 * Produces a human-readable notification string for a triggered price alert.
 *
 * The message format is:
 * ```
 * Price alert: AAPL has crossed above $200.00, now at $201.30 (+1.8% today).
 * ```
 * If the alert carries a non-empty custom `message`, it is appended after the
 * generated sentence:
 * ```
 * Price alert: AAPL has crossed above $200.00, now at $201.30 (+1.8% today). Your note here.
 * ```
 *
 * @param alert - The triggered {@link PriceAlert} (or any {@link PriceAlert}
 *                with a resolved direction and targetPrice).
 * @param quote - The live {@link Quote} for the alert's symbol, used to obtain
 *                the current price and intraday percentage change.
 * @returns A formatted, user-facing alert string suitable for prompt injection.
 *
 * @example
 * ```ts
 * const msg = formatAlertMessage(alert, quote);
 * // "Price alert: AAPL has crossed above $200.00, now at $201.30 (+1.8% today)."
 * ```
 */
export declare function formatAlertMessage(alert: PriceAlert, quote: Quote): string;
/**
 * Adds a new {@link PriceAlert} to `state.priceAlerts` and returns the
 * updated state.
 *
 * The alert is created with:
 * - `id` — a freshly generated UUID (via `crypto.randomUUID()`).
 * - `active: true` — immediately monitored on the next sync cycle.
 * - `triggeredAt: null` — has not yet fired.
 * - `createdAt` — current ISO 8601 datetime.
 *
 * The input `state` is **not** mutated; a new state object is returned.
 *
 * @param state       - Current tool state.
 * @param symbol      - Uppercase ticker symbol to monitor (e.g. `"AAPL"`).
 * @param targetPrice - Price threshold in USD (or the symbol's native currency).
 * @param direction   - `"above"` fires when price ≥ target; `"below"` fires
 *                      when price ≤ target.
 * @param message     - Optional custom text appended to the generated alert
 *                      message. Defaults to an empty string.
 * @returns A new {@link ToolState} with the alert appended to `priceAlerts`.
 *
 * @example
 * ```ts
 * const newState = createAlert(state, "AAPL", 200, "above", "Time to review!");
 * await saveState(dataDir, newState);
 * ```
 */
export declare function createAlert(state: ToolState, symbol: string, targetPrice: number, direction: "above" | "below", message?: string): ToolState;
/**
 * Removes a {@link PriceAlert} from `state.priceAlerts` by its unique `id`.
 *
 * If no alert with the given `alertId` exists, the state is returned unchanged.
 * The input `state` is **not** mutated; a new state object is returned.
 *
 * @param state   - Current tool state.
 * @param alertId - The `id` of the alert to remove (as returned by
 *                  {@link createAlert} or visible in `state.priceAlerts[n].id`).
 * @returns A new {@link ToolState} with the matching alert removed.
 *
 * @example
 * ```ts
 * const newState = deleteAlert(state, "f47ac10b-58cc-4372-a567-0e02b2c3d479");
 * await saveState(dataDir, newState);
 * ```
 */
export declare function deleteAlert(state: ToolState, alertId: string): ToolState;
//# sourceMappingURL=alerts.d.ts.map