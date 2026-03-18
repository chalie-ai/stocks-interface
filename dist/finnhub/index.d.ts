/**
 * @file src/finnhub/index.ts
 * @description Public re-exports for the Finnhub API client module.
 *
 * Exposes the HTTP client, type definitions, and rate-limiter
 * used throughout the stocks-interface tool.
 */
export { FinnhubClient, FinnhubAuthError, FinnhubNetworkError, FinnhubApiError, } from "./client.js";
export type { MetricsCacheEntry } from "./client.js";
export { RateLimiter, createRateLimiter } from "./rate-limiter.js";
export type { Quote, BasicMetrics, CompanyProfile, MarketStatus, CandleData, NewsItem, WatchlistItem, PriceAlert, ToolState, Settings, } from "./types.js";
//# sourceMappingURL=index.d.ts.map