/**
 * @file src/capabilities/index.ts
 * @description Public re-exports for all tool capabilities.
 *
 * Each capability corresponds to a named handler invokable by the Chalie
 * reasoning layer: stock_quote, stock_search, stock_compare, stock_history,
 * stock_news, watchlist_add, watchlist_remove, set_alert, market_status, and
 * earnings_calendar.
 */

export { handleStockQuote } from "./stock-quote.ts";
export type { CapabilityResult } from "../utils.ts";
export { handleStockCompare } from "./stock-compare.ts";
export { handleStockHistory } from "./stock-history.ts";
export type { HistoryPeriod } from "./stock-history.ts";
export { handleStockNews } from "./stock-news.ts";
export { handleEarningsCalendar, handleMarketStatus } from "./market-status.ts";
export { handleWatchlistAdd } from "./watchlist-add.ts";
export { handleWatchlistRemove } from "./watchlist-remove.ts";
export {
  handleAlertDelete,
  handleAlertList,
  handleAlertSet,
} from "./alert-set.ts";
export type { AlertDeleteParams, AlertSetParams } from "./alert-set.ts";
