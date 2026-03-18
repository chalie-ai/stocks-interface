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

import axios from "axios";
import type { AxiosInstance } from "axios";
import { createRateLimiter } from "./rate-limiter.js";
import type { RateLimiter } from "./rate-limiter.js";
import type {
  BasicMetrics,
  CandleData,
  CompanyProfile,
  MarketStatus,
  NewsItem,
  Quote,
} from "./types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Finnhub REST API base URL (v1). */
const FINNHUB_BASE_URL = "https://finnhub.io/api/v1";

/**
 * Cache TTL for company profiles and basic metrics: 24 hours in milliseconds.
 * Both data sets change infrequently and are expensive to re-fetch on every
 * sync cycle.
 */
const DAILY_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

// ---------------------------------------------------------------------------
// Error classes
// ---------------------------------------------------------------------------

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
export class FinnhubAuthError extends Error {
  /**
   * @param message - Human-readable description; defaults to a standard
   *   "invalid API key" message.
   */
  constructor(
    message = "Finnhub authentication failed. Please check your API key.",
  ) {
    super(message);
    this.name = "FinnhubAuthError";
  }
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
export class FinnhubNetworkError extends Error {
  /**
   * @param message - Human-readable description of the network failure.
   */
  constructor(message: string) {
    super(message);
    this.name = "FinnhubNetworkError";
  }
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
export class FinnhubApiError extends Error {
  /**
   * @param status  - The HTTP status code returned by Finnhub.
   * @param message - Human-readable description of the error.
   */
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "FinnhubApiError";
  }
}

// ---------------------------------------------------------------------------
// Internal raw-response types (never exported — callers see mapped types)
// ---------------------------------------------------------------------------

/**
 * Raw JSON shape returned by `GET /quote`.
 *
 * Field names follow Finnhub's single-letter convention. `v` (volume) is
 * absent from the free-tier quote endpoint and is therefore optional.
 */
interface RawQuoteResponse {
  /** Current price. */
  c: number;
  /** Absolute change from previous close. */
  d: number;
  /** Percentage change from previous close. */
  dp: number;
  /** Day high. */
  h: number;
  /** Day low. */
  l: number;
  /** Day open. */
  o: number;
  /** Previous close. */
  pc: number;
  /** Unix timestamp of the last trade (seconds). */
  t: number;
  /** Intraday volume — absent on the free-tier quote endpoint. */
  v?: number;
}

/**
 * Raw JSON shape returned by `GET /stock/metric?metric=all`.
 *
 * Only the subset of fields consumed by this tool is declared here.
 * `peNormalizedAnnual` may be absent for companies with negative earnings.
 */
interface RawMetricResponse {
  /** The symbol the metrics belong to, as echoed back by Finnhub. */
  symbol: string;
  /** Nested object containing the flat metric key/value map. */
  metric: {
    /** Trailing 52-week closing high. */
    "52WeekHigh": number | null;
    /** Trailing 52-week closing low. */
    "52WeekLow": number | null;
    /**
     * 10-day average daily trading volume (in millions of shares on some
     * endpoints — callers treat this as raw units from Finnhub).
     */
    "10DayAverageTradingVolume": number | null;
    /**
     * Normalised annual P/E ratio. `null` when unavailable (e.g. negative
     * earnings, ETFs).
     */
    peNormalizedAnnual: number | null;
    /** Market capitalisation in USD millions. */
    marketCapitalization: number | null;
  };
}

/**
 * Raw JSON shape returned by `GET /stock/profile2`.
 *
 * Only the subset of fields consumed by this tool is declared here.
 */
interface RawProfileResponse {
  /** Ticker symbol as echoed by Finnhub. */
  ticker: string;
  /** Full legal company / fund name. */
  name: string;
  /** Exchange identifier (e.g. `"NASDAQ NMS - GLOBAL MARKET"`). */
  exchange: string;
  /** GICS industry classification or fund category. */
  finnhubIndustry: string;
  /** Market capitalisation in USD millions. */
  marketCapitalization: number;
  /** URL to the company logo, or empty string. */
  logo: string;
}

/**
 * Raw JSON shape returned by `GET /stock/market-status`.
 *
 * Only the fields relevant to this tool are declared here.
 */
interface RawMarketStatusResponse {
  /** Exchange code (e.g. `"NYSE"`, `"NASDAQ"`). */
  exchange: string;
  /** `true` when the exchange is in its regular trading session. */
  isOpen: boolean;
  /**
   * Holiday name causing a closure, or `null` when the exchange is operating
   * normally or is closed for a non-holiday reason (weekend, etc.).
   */
  holiday: string | null;
}

/**
 * Raw JSON shape returned by `GET /stock/candle`.
 *
 * All OHLCV arrays are absent when `s === "no_data"`.
 */
interface RawCandleResponse {
  /** `"ok"` when data was found; `"no_data"` when the range has no trades. */
  s: "ok" | "no_data";
  /** Close prices (one per candle). */
  c?: number[];
  /** High prices (one per candle). */
  h?: number[];
  /** Low prices (one per candle). */
  l?: number[];
  /** Open prices (one per candle). */
  o?: number[];
  /** Unix timestamps in seconds for each candle's open time. */
  t?: number[];
  /** Trading volumes for each candle. */
  v?: number[];
}

/**
 * Raw JSON shape for a single news article returned by `GET /company-news`.
 *
 * The shape closely mirrors {@link NewsItem} but uses the exact Finnhub field
 * names to avoid confusion during mapping.
 */
interface RawNewsArticle {
  /** Article headline. */
  headline: string;
  /** Brief summary or lede; may be an empty string. */
  summary: string;
  /** News source name (e.g. `"Reuters"`). */
  source: string;
  /** Unix timestamp (seconds) of publication. */
  datetime: number;
  /** Canonical URL of the article. */
  url: string;
  /** Comma-separated related ticker symbols (e.g. `"AAPL,MSFT"`). */
  related: string;
}

// ---------------------------------------------------------------------------
// Cache entry types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// FinnhubClient
// ---------------------------------------------------------------------------

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
export class FinnhubClient {
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
  public readonly profileCache: Map<string, CompanyProfile>;

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
  public readonly metricsCache: Map<string, MetricsCacheEntry>;

  /** Configured axios instance with `baseURL` and `token` param pre-set. */
  private readonly http: AxiosInstance;

  /** Shared rate limiter; defaults to a fresh instance if not supplied. */
  private readonly rateLimiter: RateLimiter;

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
  constructor(apiKey: string, rateLimiter?: RateLimiter) {
    this.profileCache = new Map();
    this.metricsCache = new Map();
    this.rateLimiter = rateLimiter ?? createRateLimiter();
    this.http = axios.create({
      baseURL: FINNHUB_BASE_URL,
      // Attach the API key to every request via the `token` query param.
      params: { token: apiKey },
    });
  }

  // -------------------------------------------------------------------------
  // Private HTTP helpers
  // -------------------------------------------------------------------------

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
  private async get<T>(
    path: string,
    params: Record<string, string>,
    priority: number,
  ): Promise<T> {
    return this.rateLimiter.enqueue(async () => {
      try {
        const response = await this.http.get<T>(path, { params });
        return response.data;
      } catch (err: unknown) {
        if (axios.isAxiosError(err)) {
          if (!err.response) {
            // Network-layer failure: no HTTP response was received.
            throw new FinnhubNetworkError(
              `Network error calling Finnhub ${path}: ${err.message}`,
            );
          }

          if (err.response.status === 401) {
            throw new FinnhubAuthError();
          }

          throw new FinnhubApiError(
            err.response.status,
            `Finnhub API error (${err.response.status}) on ${path}`,
          );
        }
        // Re-throw anything that is not an AxiosError unchanged.
        throw err;
      }
    }, priority);
  }

  // -------------------------------------------------------------------------
  // Public API methods
  // -------------------------------------------------------------------------

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
  async quote(symbol: string): Promise<Quote> {
    const raw = await this.get<RawQuoteResponse>(
      "/quote",
      { symbol },
      2, // tier 2: watchlist sync
    );

    return {
      symbol,
      name: this.profileCache.get(symbol)?.name ?? null,
      price: raw.c,
      change: raw.d,
      changePercent: raw.dp,
      high: raw.h,
      low: raw.l,
      open: raw.o,
      previousClose: raw.pc,
      timestamp: raw.t,
      // Volume is not provided by the free-tier /quote endpoint.
      // Callers that need real volume should use candles() and aggregate.
      volume: raw.v ?? 0,
    };
  }

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
  async basicMetrics(symbol: string): Promise<BasicMetrics> {
    const cached = this.metricsCache.get(symbol);
    if (cached !== undefined && Date.now() - cached.fetchedAt < DAILY_CACHE_TTL_MS) {
      return cached.data;
    }

    const raw = await this.get<RawMetricResponse>(
      "/stock/metric",
      { symbol, metric: "all" },
      3, // tier 3: daily, staggered
    );

    const data: BasicMetrics = {
      symbol,
      fiftyTwoWeekHigh: raw.metric["52WeekHigh"] ?? 0,
      fiftyTwoWeekLow: raw.metric["52WeekLow"] ?? 0,
      averageVolume10Day: raw.metric["10DayAverageTradingVolume"] ?? 0,
      peRatio: raw.metric.peNormalizedAnnual ?? null,
      marketCap: raw.metric.marketCapitalization ?? 0,
    };

    this.metricsCache.set(symbol, { data, fetchedAt: Date.now() });
    return data;
  }

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
  async companyProfile(symbol: string): Promise<CompanyProfile> {
    const raw = await this.get<RawProfileResponse>(
      "/stock/profile2",
      { symbol },
      3, // tier 3: daily, staggered
    );

    const profile: CompanyProfile = {
      symbol,
      name: raw.name,
      exchange: raw.exchange,
      industry: raw.finnhubIndustry,
      marketCap: raw.marketCapitalization,
      logo: raw.logo,
    };

    this.profileCache.set(symbol, profile);
    return profile;
  }

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
  async candles(
    symbol: string,
    resolution: string,
    from: number,
    to: number,
  ): Promise<CandleData> {
    const raw = await this.get<RawCandleResponse>(
      "/stock/candle",
      {
        symbol,
        resolution,
        from: String(from),
        to: String(to),
      },
      2, // tier 2: sparkline rendering
    );

    return {
      status: raw.s,
      c: raw.c ?? [],
      h: raw.h ?? [],
      l: raw.l ?? [],
      o: raw.o ?? [],
      t: raw.t ?? [],
      v: raw.v ?? [],
    };
  }

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
  async news(symbol: string, from: string, to: string): Promise<NewsItem[]> {
    const raw = await this.get<RawNewsArticle[]>(
      "/company-news",
      { symbol, from, to },
      4, // tier 4: background, deferrable
    );

    return raw.map(
      (article): NewsItem => ({
        headline: article.headline,
        summary: article.summary,
        source: article.source,
        datetime: article.datetime,
        url: article.url,
        related: article.related,
      }),
    );
  }

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
  async marketStatus(exchange = "US"): Promise<MarketStatus> {
    const raw = await this.get<RawMarketStatusResponse>(
      "/stock/market-status",
      { exchange },
      2, // tier 2: sync cycle gate
    );

    return {
      exchange: raw.exchange,
      isOpen: raw.isOpen,
      holiday: raw.holiday,
    };
  }
}
