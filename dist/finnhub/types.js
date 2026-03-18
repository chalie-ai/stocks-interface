/**
 * @file src/finnhub/types.ts
 * @description TypeScript interface definitions for all Finnhub API response
 * shapes and internal domain models used throughout the stocks-interface tool.
 *
 * Interfaces map to the following Finnhub REST endpoints:
 *  - `GET /quote`              → {@link Quote}
 *  - `GET /stock/metric`       → {@link BasicMetrics}
 *  - `GET /stock/profile2`     → {@link CompanyProfile}
 *  - `GET /stock/exchange-status` / market-status → {@link MarketStatus}
 *  - `GET /stock/candle`       → {@link CandleData}
 *  - `GET /company-news`       → {@link NewsItem}
 *
 * Internal domain models:
 *  - {@link WatchlistItem}  — a user-tracked symbol
 *  - {@link PriceAlert}     — a user-configured price threshold alert
 *  - {@link ToolState}      — persisted `_state` blob for Chalie's tool contract
 *  - {@link Settings}       — user-configurable sync and notification preferences
 *
 * Design notes:
 *  - No `any` types. All fields are explicitly typed.
 *  - `Quote.name` is `string | null` because the company name comes from a
 *    separate profile-cache fetch, which may not yet have been populated.
 *  - `peRatio` in {@link BasicMetrics} is `string | null` because some stocks
 *    (e.g. negative-earnings companies) lack a meaningful P/E ratio in the
 *    Finnhub response.
 *  - `WatchlistItem.type` includes `"crypto"` for forward-compatibility, though
 *    crypto symbols are excluded from v1 market-hours logic.
 *
 * @module stocks-interface/finnhub/types
 */
export {};
//# sourceMappingURL=types.js.map