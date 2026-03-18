/**
 * @file src/index.ts
 * @description Main daemon entry point for the stocks-interface Chalie tool.
 *
 * Implements the Chalie tool IPC contract:
 *  1. Reads a base64-encoded JSON payload from `process.argv[2]`.
 *  2. Parses {@link ToolInput} (params, settings, telemetry).
 *  3. Loads persisted {@link ToolState} from disk via {@link loadState}.
 *  4. Resolves the Finnhub API key (`settings.apiKey` overrides `state.apiKey`).
 *  5. Shows the setup wizard HTML if no API key is available.
 *  6. Dispatches to the correct capability handler based on `params.capability`.
 *  7. Persists any mutated state returned by the handler.
 *  8. Writes a JSON result `{ text, html }` to stdout.
 *  9. Optionally starts the background {@link MarketSync} loop when the
 *     `STOCKS_DAEMON` environment variable equals `"1"`.
 * 10. Handles `SIGINT`/`SIGTERM` for graceful shutdown: stops the sync loop,
 *     flushes state to disk, then calls `process.exit(0)`.
 *
 * ## Capability dispatch table
 * | `params.capability`   | Handler                   | Mutates state |
 * |-----------------------|---------------------------|---------------|
 * | `stock_quote`         | {@link handleStockQuote}  | No            |
 * | `stock_compare`       | {@link handleStockCompare}| No            |
 * | `stock_history`       | {@link handleStockHistory}| No            |
 * | `stock_news`          | {@link handleStockNews}   | No            |
 * | `market_status`       | {@link handleMarketStatus}| No            |
 * | `earnings_calendar`   | {@link handleEarningsCalendar} | No       |
 * | `watchlist_add`       | {@link handleWatchlistAdd}| Yes           |
 * | `watchlist_remove`    | {@link handleWatchlistRemove} | Yes       |
 * | `alert_set`           | {@link handleAlertSet}    | Yes           |
 * | `alert_list`          | {@link handleAlertList}   | No            |
 * | `alert_delete`        | {@link handleAlertDelete} | Yes           |
 * | _(unknown)_           | Main dashboard view       | No            |
 *
 * ## Error routing
 * | Thrown class               | Output HTML                                  |
 * |----------------------------|----------------------------------------------|
 * | {@link FinnhubAuthError}   | `renderSetupPage({ type: "auth", ... })`     |
 * | {@link FinnhubNetworkError}| `renderSetupPage({ type: "network", ... })`  |
 * | Other `Error`              | Inline `<div>` with the error message        |
 *
 * @module stocks-interface
 */
/**
 * Unique tool identifier string used by the Chalie runtime to route IPC
 * messages to this tool. Must match the `name` field in `manifest.json`.
 */
export declare const TOOL_NAME = "stocks-interface";
/**
 * Semantic version of this tool. Incremented on each release; exposed here
 * so the version can be included in rendered UI cards and diagnostic output.
 */
export declare const TOOL_VERSION = "0.1.0";
//# sourceMappingURL=index.d.ts.map