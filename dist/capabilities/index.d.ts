/**
 * @file src/capabilities/index.ts
 * @description Public re-exports for all tool capabilities.
 *
 * Each capability corresponds to a named handler invokable by the Chalie
 * reasoning layer: stock_quote, stock_search, stock_compare, stock_history,
 * stock_news, watchlist_add, watchlist_remove, set_alert, and market_overview.
 */
export { handleStockQuote } from "./stock-quote.js";
export type { CapabilityResult } from "./stock-quote.js";
export { handleStockCompare } from "./stock-compare.js";
export { handleStockHistory } from "./stock-history.js";
export type { HistoryPeriod } from "./stock-history.js";
export { handleStockNews } from "./stock-news.js";
//# sourceMappingURL=index.d.ts.map