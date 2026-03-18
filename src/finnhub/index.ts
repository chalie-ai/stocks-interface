/**
 * @file src/finnhub/index.ts
 * @description Public re-exports for the Finnhub API client module.
 *
 * Exposes the HTTP client, type definitions, and rate-limiter
 * used throughout the stocks-interface tool.
 */

export {
  FinnhubClient,
  FinnhubAuthError,
  FinnhubNetworkError,
  FinnhubApiError,
} from "./client.ts";
export type { MetricsCacheEntry } from "./client.ts";
export { RateLimiter, createRateLimiter } from "./rate-limiter.ts";
export type {
  Quote,
  BasicMetrics,
  CompanyProfile,
  MarketStatus,
  CandleData,
  NewsItem,
  WatchlistItem,
  PriceAlert,
  ToolState,
  Settings,
} from "./types.ts";
