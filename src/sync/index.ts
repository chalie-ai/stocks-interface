/**
 * @file src/sync/index.ts
 * @description Public re-exports for the market-sync and alerts modules.
 *
 * The sync layer is responsible for polling Finnhub on a configurable
 * interval, evaluating threshold conditions, and emitting Chalie signals.
 */

export { MarketSync } from "./market-sync.ts";
export type {
  Signal,
  OnSignalFn,
  OnSummaryFn,
  StopFn,
} from "./market-sync.ts";
export {
  checkAlerts,
  createAlert,
  deleteAlert,
  formatAlertMessage,
} from "./alerts.ts";
export type { CheckAlertsResult, TriggeredAlert } from "./alerts.ts";
