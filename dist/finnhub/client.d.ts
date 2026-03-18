/**
 * @file src/finnhub/client.ts
 * @description Typed HTTP client for the Finnhub REST API.
 *
 * Responsibilities:
 *  - Wrap every outbound HTTP call through the {@link RateLimiter} so the
 *    free-tier ceiling of 55 req/min is never exceeded.
 *  - Maintain a `profileCache` (company name + exchange meta) and a
 *    `metricsCache` (52-week range, average volume, P/E) so callers do not
 *    trigger redundant network requests on every sync cycle.
 *  - Classify HTTP and network failures into three distinct typed errors:
 *      - HTTP 401  → {@link FinnhubAuthError}
 *      - Network unreachable / timeout → {@link FinnhubNetworkError}
 *      - Other non-2xx responses → {@link FinnhubApiError}
 *
 * ## Priority tier assignments (see rate-limiter.ts for tier semantics)
 * | Method            | Tier | Rationale                              |
 * |-------------------|------|----------------------------------------|
 * | `quote`           | 2    | Watchlist sync cycle                   |
 * | `marketStatus`    | 2    | Sync cycle gate (drives poll interval) |
 * | `candles`         | 2    | Sparkline rendering, viewport-bound    |
 * | `companyProfile`  | 3    | Daily cache refresh, staggered         |
 * | `basicMetrics`    | 3    | Daily cache refresh, staggered         |
 * | `news`            | 4    | Background, deferrable                 |
 *
 * @module stocks-interface/finnhub/client
 */
import type { RateLimiter } from "./rate-limiter.js";
import type { BasicMetrics, CandleData, CompanyProfile, MarketStatus, NewsItem, Quote } from "./types.js";
/**
 * Thrown when Finnhub responds with HTTP 401 (invalid or missing API key).
 *
 * The caller should surface this to the user with a message like
 * "This API key doesn't seem to work — please double-check you copied the
 * full key."
 *
 * @example
 * ```ts
 * try {
 *   await client.quote("AAPL");
 * } catch (err) {
 *   if (err instanceof FinnhubAuthError) {
 *     showSetupWizard("Invalid API key");
 *   }
 * }
 * ```
 */
export declare class FinnhubAuthError extends Error {
    /**
     * @param message - Human-readable description; defaults to a standard
     *   "invalid API key" message.
     */
    constructor(message?: string);
}
/**
 * Thrown when a request to Finnhub fails at the network layer (DNS failure,
 * connection refused, timeout, etc.) before a response is received.
 *
 * The caller should distinguish this from {@link FinnhubAuthError} and show
 * a message like "Couldn't connect to Finnhub — please check your internet
 * connection."
 *
 * @example
 * ```ts
 * } catch (err) {
 *   if (err instanceof FinnhubNetworkError) {
 *     showBanner("No network — showing last-known data");
 *   }
 * }
 * ```
 */
export declare class FinnhubNetworkError extends Error {
    /**
     * @param message - Human-readable description of the network failure.
     */
    constructor(message: string);
}
/**
 * Thrown when Finnhub returns a non-2xx status other than 401.
 *
 * The `status` property carries the raw HTTP status code for caller-side
 * branching (e.g. to treat 500-range errors differently from 400-range ones).
 *
 * @example
 * ```ts
 * } catch (err) {
 *   if (err instanceof FinnhubApiError && err.status >= 500) {
 *     // Finnhub server-side issue — retry later
 *   }
 * }
 * ```
 */
export declare class FinnhubApiError extends Error {
    readonly status: number;
    /**
     * @param status  - The HTTP status code returned by Finnhub.
     * @param message - Human-readable description of the error.
     */
    constructor(status: number, message: string);
}
/**
 * A stamped wrapper around a cached {@link BasicMetrics} value.
 *
 * `fetchedAt` is a Unix millisecond timestamp used to determine whether the
 * cached value has exceeded the {@link DAILY_CACHE_TTL_MS} threshold.
 */
export interface MetricsCacheEntry {
    /** The cached metrics data. */
    data: BasicMetrics;
    /** Unix millisecond timestamp when the data was fetched from Finnhub. */
    fetchedAt: number;
}
/**
 * Typed HTTP client for the Finnhub REST API.
 *
 * Wrap every outbound request through the supplied (or internally created)
 * {@link RateLimiter} to stay within Finnhub's free-tier quota of 60 req/min.
 * A hard ceiling of 55 req/min is enforced by the limiter, leaving 5 req/min
 * headroom for transient bursts.
 *
 * ### Caches
 * - **`profileCache`** — keyed by symbol; populated by {@link companyProfile}
 *   and used by {@link quote} to resolve `name` without blocking.
 * - **`metricsCache`** — keyed by symbol; populated by {@link basicMetrics};
 *   entries older than 24 h trigger a background refresh.
 *
 * ### Error model
 * | Condition | Error class |
 * |-----------|-------------|
 * | HTTP 401 | {@link FinnhubAuthError} |
 * | No response (network failure) | {@link FinnhubNetworkError} |
 * | Other non-2xx HTTP status | {@link FinnhubApiError} |
 *
 * @example
 * ```ts
 * const client = new FinnhubClient("your-api-key");
 *
 * // Warm the profile cache before quoting
 * await client.companyProfile("AAPL");
 *
 * // quote.name is now populated from cache
 * const q = await client.quote("AAPL");
 * console.log(`${q.name}: $${q.price}`);
 * ```
 */
export declare class FinnhubClient {
    /**
     * In-memory cache of company profiles, keyed by upper-case symbol.
     *
     * Populated by calls to {@link companyProfile}; consulted by {@link quote}
     * to resolve `Quote.name` without making an additional network request.
     * Entries are refreshed once per day by the sync layer.
     *
     * Exposed as public so the sync layer can pre-warm and inspect the cache
     * directly without calling `companyProfile` for every watchlist item.
     */
    readonly profileCache: Map<string, CompanyProfile>;
    /**
     * In-memory cache of basic financial metrics, keyed by upper-case symbol.
     *
     * Each entry wraps a {@link BasicMetrics} value with a `fetchedAt` timestamp.
     * {@link basicMetrics} returns the cached value when it is less than 24 h old
     * and transparently re-fetches when the entry has expired or is absent.
     *
     * Exposed as public so the sync layer can inspect cache staleness and trigger
     * targeted refreshes without calling {@link basicMetrics} for every symbol.
     */
    readonly metricsCache: Map<string, MetricsCacheEntry>;
    /** Configured axios instance with `baseURL` and `token` param pre-set. */
    private readonly http;
    /** Shared rate limiter; defaults to a fresh instance if not supplied. */
    private readonly rateLimiter;
    /**
     * Constructs a new {@link FinnhubClient} with clean caches and a configured
     * axios instance.
     *
     * @param apiKey      - Finnhub API key used as the `token` query parameter
     *                      on every outbound request.
     * @param rateLimiter - Optional pre-configured {@link RateLimiter} to share
     *                      across multiple client instances. When omitted, a new
     *                      limiter is created internally (appropriate for most
     *                      use-cases where only one client exists per process).
     */
    constructor(apiKey: string, rateLimiter?: RateLimiter);
    /**
     * Issues an authenticated GET request through the rate limiter.
     *
     * Handles error classification:
     * - HTTP 401 → {@link FinnhubAuthError}
     * - No response (network error) → {@link FinnhubNetworkError}
     * - Any other non-2xx status → {@link FinnhubApiError}
     *
     * @template T - Expected parsed response body type.
     * @param path     - API path relative to {@link FINNHUB_BASE_URL}
     *                   (e.g. `"/quote"`). Must start with `"/"`.
     * @param params   - Additional query parameters merged with the global `token`
     *                   param (e.g. `{ symbol: "AAPL" }`).
     * @param priority - Rate-limiter priority tier (1–4; lower = higher urgency).
     * @returns        Parsed JSON response body typed as `T`.
     * @throws {FinnhubAuthError}    On HTTP 401.
     * @throws {FinnhubNetworkError} When no HTTP response is received.
     * @throws {FinnhubApiError}     On any other non-2xx response.
     */
    private get;
    /**
     * Fetches a real-time quote for the given symbol.
     *
     * Calls `GET /quote?symbol={symbol}` (priority tier 2 — watchlist sync).
     *
     * The returned `Quote.name` field is populated from `profileCache` if the
     * symbol has a cached profile; otherwise `null` is returned. The method
     * never blocks waiting for a profile fetch — callers should warm the cache
     * via {@link companyProfile} before the first sync cycle if `name` is
     * required immediately.
     *
     * `Quote.volume` is set to `0` because the Finnhub `/quote` endpoint does
     * not include intraday volume on the free tier. Use {@link candles} to
     * compute actual volume, or compare against
     * `BasicMetrics.averageVolume10Day` for relative volume signals.
     *
     * @param symbol - Ticker symbol in Finnhub format (e.g. `"AAPL"`, `"SPY"`).
     * @returns       A fully typed {@link Quote} with `name` resolved from cache.
     * @throws {FinnhubAuthError}    On HTTP 401.
     * @throws {FinnhubNetworkError} On network failure.
     * @throws {FinnhubApiError}     On other API errors.
     */
    quote(symbol: string): Promise<Quote>;
    /**
     * Fetches key financial metrics for a symbol, using a 24-hour cache.
     *
     * Calls `GET /stock/metric?metric=all&symbol={symbol}` (priority tier 3 —
     * daily, staggered via the rate limiter).
     *
     * If a cached entry exists and is less than {@link DAILY_CACHE_TTL_MS} old,
     * the cached value is returned immediately without a network call. Otherwise
     * a fresh fetch is made and the cache is updated.
     *
     * Metrics sourced here:
     * - `fiftyTwoWeekHigh` / `fiftyTwoWeekLow` — for 52-week milestone alerts
     * - `averageVolume10Day` — baseline for "unusual volume (> 3× average)" alerts
     * - `peRatio` — used in stock comparison (`stock_compare` capability)
     * - `marketCap` — supplementary display field
     *
     * @param symbol - Ticker symbol in Finnhub format (e.g. `"AAPL"`, `"SPY"`).
     * @returns       A fully typed {@link BasicMetrics} value.
     * @throws {FinnhubAuthError}    On HTTP 401 (uncached fetch only).
     * @throws {FinnhubNetworkError} On network failure (uncached fetch only).
     * @throws {FinnhubApiError}     On other API errors (uncached fetch only).
     */
    basicMetrics(symbol: string): Promise<BasicMetrics>;
    /**
     * Fetches the company (or fund) profile for a symbol and updates
     * `profileCache`.
     *
     * Calls `GET /stock/profile2?symbol={symbol}` (priority tier 3 — daily,
     * staggered). The result is stored in `profileCache` so that subsequent
     * calls to {@link quote} can resolve `Quote.name` without an extra request.
     *
     * Call this method once per watchlisted symbol at tool startup and then
     * once per day during the background refresh cycle.
     *
     * @param symbol - Ticker symbol in Finnhub format (e.g. `"AAPL"`, `"SPY"`).
     * @returns       A fully typed {@link CompanyProfile} value. Also updates
     *                `this.profileCache` as a side-effect.
     * @throws {FinnhubAuthError}    On HTTP 401.
     * @throws {FinnhubNetworkError} On network failure.
     * @throws {FinnhubApiError}     On other API errors.
     */
    companyProfile(symbol: string): Promise<CompanyProfile>;
    /**
     * Fetches OHLCV candlestick data for a symbol over a given time range.
     *
     * Calls `GET /stock/candle?symbol={symbol}&resolution={resolution}&from={from}&to={to}`
     * (priority tier 2 — sparkline rendering, viewport-bound).
     *
     * When Finnhub has no data for the requested range, it returns
     * `{ s: "no_data" }` with all array fields absent. In that case all array
     * fields in the returned {@link CandleData} are set to empty arrays.
     *
     * Common resolutions: `"1"` (1 min), `"5"`, `"15"`, `"30"`, `"60"`,
     * `"D"` (daily), `"W"` (weekly), `"M"` (monthly).
     *
     * @param symbol     - Ticker symbol in Finnhub format (e.g. `"AAPL"`).
     * @param resolution - Candlestick resolution string (e.g. `"D"`, `"60"`).
     * @param from       - Range start as Unix timestamp in seconds.
     * @param to         - Range end as Unix timestamp in seconds.
     * @returns           A fully typed {@link CandleData} value with empty arrays
     *                    when no data is available.
     * @throws {FinnhubAuthError}    On HTTP 401.
     * @throws {FinnhubNetworkError} On network failure.
     * @throws {FinnhubApiError}     On other API errors.
     */
    candles(symbol: string, resolution: string, from: number, to: number): Promise<CandleData>;
    /**
     * Fetches company news articles for a symbol over a given date range.
     *
     * Calls `GET /company-news?symbol={symbol}&from={from}&to={to}`
     * (priority tier 4 — background, deferrable).
     *
     * Used to surface relevant news when a stock makes a notable move, giving
     * Chalie context to explain the price action. Callers should fetch news
     * lazily (only for stocks that triggered a signal) to conserve API quota.
     *
     * @param symbol - Ticker symbol in Finnhub format (e.g. `"AAPL"`).
     * @param from   - Start date in `YYYY-MM-DD` format (inclusive).
     * @param to     - End date in `YYYY-MM-DD` format (inclusive).
     * @returns       Array of {@link NewsItem} objects ordered newest-first by
     *                Finnhub. Returns an empty array when no articles are found.
     * @throws {FinnhubAuthError}    On HTTP 401.
     * @throws {FinnhubNetworkError} On network failure.
     * @throws {FinnhubApiError}     On other API errors.
     */
    news(symbol: string, from: string, to: string): Promise<NewsItem[]>;
    /**
     * Fetches the current open/closed status for a stock exchange.
     *
     * Calls `GET /stock/market-status?exchange={exchange}`
     * (priority tier 2 — sync cycle gate).
     *
     * The result drives the sync polling interval: when the exchange is open,
     * quotes are refreshed every ~2 minutes; when closed, every ~5 minutes.
     * Also used to detect the market-close transition that triggers the
     * end-of-day summary signal.
     *
     * @param exchange - Exchange code to query; defaults to `"US"` for US
     *                   equities (NYSE, NASDAQ). Other valid values include
     *                   `"LSE"`, `"TSX"`, etc.
     * @returns         A fully typed {@link MarketStatus} value.
     * @throws {FinnhubAuthError}    On HTTP 401.
     * @throws {FinnhubNetworkError} On network failure.
     * @throws {FinnhubApiError}     On other API errors.
     */
    marketStatus(exchange?: string): Promise<MarketStatus>;
}
//# sourceMappingURL=client.d.ts.map