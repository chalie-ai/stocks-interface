/**
 * @file src/capabilities/index.ts
 * @description Public re-exports for all tool capabilities.
 *
 * Each capability corresponds to a named handler invokable by the Chalie
 * reasoning layer: stock_quote, stock_search, stock_compare, stock_history,
 * watchlist_add, watchlist_remove, set_alert, and market_overview.
 */
export { handleStockQuote } from "./stock-quote.js";
export { handleStockCompare } from "./stock-compare.js";
//# sourceMappingURL=index.js.map