/**
 * @file src/finnhub/index.ts
 * @description Public re-exports for the Finnhub API client module.
 *
 * Exposes the HTTP client, type definitions, and rate-limiter
 * used throughout the stocks-interface tool.
 */

export {
  FinnhubApiError,
  FinnhubAuthError,
  FinnhubClient,
  FinnhubNetworkError,
} from "./client.ts";
export type { MetricsCacheEntry } from "./client.ts";
export { createRateLimiter, RateLimiter } from "./rate-limiter.ts";
export type {
  BasicMetrics,
  CandleData,
  CompanyProfile,
  MarketStatus,
  NewsItem,
  PriceAlert,
  Quote,
  Settings,
  ToolState,
  WatchlistItem,
} from "./types.ts";
