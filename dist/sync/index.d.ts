/**
 * @file src/sync/index.ts
 * @description Public re-exports for the market-sync and alerts modules.
 *
 * The sync layer is responsible for polling Finnhub on a configurable
 * interval, evaluating threshold conditions, and emitting Chalie signals.
 */
export { MarketSync } from "./market-sync.js";
export type { Signal, OnSignalFn, OnSummaryFn, StopFn, } from "./market-sync.js";
export { checkAlerts, createAlert, deleteAlert, formatAlertMessage, } from "./alerts.js";
export type { CheckAlertsResult, TriggeredAlert } from "./alerts.js";
//# sourceMappingURL=index.d.ts.map