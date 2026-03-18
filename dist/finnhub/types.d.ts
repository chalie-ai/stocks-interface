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
/**
 * Real-time quote data returned by `GET /quote`.
 *
 * Field names follow the Finnhub API convention (single-letter keys) mapped to
 * descriptive aliases for readability. The `name` field is NOT from the quote
 * endpoint — it is populated from the profile cache and may be `null` on a
 * cache miss.
 *
 * @see https://finnhub.io/docs/api/quote
 */
export interface Quote {
    /** Ticker symbol (e.g. `"AAPL"`, `"SPY"`). */
    symbol: string;
    /**
     * Human-readable company or fund name sourced from the profile cache.
     * `null` when the profile has not yet been fetched for this symbol.
     */
    name: string | null;
    /** Current price (`c` in the Finnhub response). */
    price: number;
    /** Absolute change from the previous close (`d` in the Finnhub response). */
    change: number;
    /** Percentage change from the previous close (`dp` in the Finnhub response). */
    changePercent: number;
    /** Day high price (`h` in the Finnhub response). */
    high: number;
    /** Day low price (`l` in the Finnhub response). */
    low: number;
    /** Day open price (`o` in the Finnhub response). */
    open: number;
    /** Previous close price (`pc` in the Finnhub response). */
    previousClose: number;
    /**
     * Unix timestamp of the last trade (`t` in the Finnhub response).
     * Seconds since epoch.
     */
    timestamp: number;
    /**
     * Intraday trading volume.
     * Not directly returned by the Finnhub `/quote` endpoint; aggregated from
     * intraday candle data or the `v` field available in some market feeds.
     * Required for volume-alert comparisons against {@link BasicMetrics.averageVolume10Day}.
     */
    volume: number;
}
/**
 * Key financial metrics returned by `GET /stock/metric?metric=all`.
 *
 * Only the subset of fields used by this tool is represented here. The full
 * response contains hundreds of additional metric keys.
 *
 * Fetched once per trading day per watchlisted symbol and stored in the
 * profile cache. Not fetched on every sync cycle.
 *
 * @see https://finnhub.io/docs/api/company-basic-financials
 */
export interface BasicMetrics {
    /** Ticker symbol these metrics belong to. */
    symbol: string;
    /**
     * Highest closing price over the trailing 52-week period.
     * Used to detect "hit 52-week high" conditions.
     */
    fiftyTwoWeekHigh: number;
    /**
     * Lowest closing price over the trailing 52-week period.
     * Used to detect "hit 52-week low" conditions.
     */
    fiftyTwoWeekLow: number;
    /**
     * 10-day average daily trading volume.
     * Maps to Finnhub's `10DayAverageTradingVolume` metric field.
     * Used as the baseline for "unusual volume" alerts (> 3× average).
     */
    averageVolume10Day: number;
    /**
     * Trailing twelve-month price-to-earnings ratio.
     * `null` for companies with negative or zero earnings, or when the metric
     * is unavailable from Finnhub for the given symbol.
     */
    peRatio: number | null;
    /**
     * Market capitalisation in USD.
     * Maps to Finnhub's `marketCapitalization` metric field (reported in millions;
     * consumers must multiply by 1,000,000 if displaying in raw dollars).
     */
    marketCap: number;
}
/**
 * Company (or ETF/fund) profile returned by `GET /stock/profile2`.
 *
 * Fetched once per symbol and stored in the profile cache, which is refreshed
 * daily. The `name` field from this response populates {@link Quote.name}.
 *
 * @see https://finnhub.io/docs/api/company-profile2
 */
export interface CompanyProfile {
    /** Ticker symbol. */
    symbol: string;
    /** Full legal name of the company or fund (e.g. `"Apple Inc"`). */
    name: string;
    /** Stock exchange the symbol is listed on (e.g. `"NASDAQ"`, `"NYSE"`). */
    exchange: string;
    /**
     * GICS sub-industry or fund category (e.g. `"Technology"`, `"ETF"`).
     * May be an empty string for ETFs and indices that lack SIC classification.
     */
    industry: string;
    /**
     * Market capitalisation in USD millions.
     * Mirrors {@link BasicMetrics.marketCap}; included here so callers can
     * render a market-cap figure from the profile cache without a separate
     * metrics fetch.
     */
    marketCap: number;
    /**
     * URL to the company logo image, or an empty string if unavailable.
     * Suitable for use in `<img src>` directly.
     */
    logo: string;
}
/**
 * Market open/closed status for a given exchange.
 *
 * Used to adapt the sync polling interval: faster when the market is open,
 * slower when closed, and to trigger the end-of-day market summary signal.
 *
 * @see https://finnhub.io/docs/api/market-status
 */
export interface MarketStatus {
    /**
     * Exchange code (e.g. `"US"` for US equities).
     * Matches the exchange codes used in {@link WatchlistItem.exchange}.
     */
    exchange: string;
    /** `true` if the exchange is currently in its regular trading session. */
    isOpen: boolean;
    /**
     * Name of the holiday causing a market closure, or `null` when the market
     * is operating normally or is closed for a non-holiday reason (e.g. weekend).
     */
    holiday: string | null;
}
/**
 * OHLCV candlestick data returned by `GET /stock/candle`.
 *
 * All array fields (`o`, `h`, `l`, `c`, `v`, `t`) are parallel arrays of
 * equal length. Index `i` across all arrays represents the same time bucket.
 *
 * When no data is available for the requested range, Finnhub returns
 * `{ status: "no_data" }` with all array fields absent. Callers must check
 * `status` before accessing the arrays.
 *
 * @see https://finnhub.io/docs/api/stock-candles
 */
export interface CandleData {
    /**
     * Response status.
     * - `"ok"` — data was found; all array fields are populated.
     * - `"no_data"` — no trades exist for the requested range; arrays will be empty.
     */
    status: "ok" | "no_data";
    /** Open prices for each candle, in chronological order. */
    o: number[];
    /** High prices for each candle, in chronological order. */
    h: number[];
    /** Low prices for each candle, in chronological order. */
    l: number[];
    /** Close prices for each candle, in chronological order. */
    c: number[];
    /** Trading volumes for each candle, in chronological order. */
    v: number[];
    /**
     * Unix timestamps (seconds) for each candle's open time, in chronological order.
     * Use to map candles to wall-clock time when rendering sparklines or history charts.
     */
    t: number[];
}
/**
 * A single news article from `GET /company-news` or `GET /news`.
 *
 * Used to surface relevant company news when a stock makes a notable move,
 * giving Chalie context to explain the price action.
 *
 * @see https://finnhub.io/docs/api/company-news
 */
export interface NewsItem {
    /** Article headline. */
    headline: string;
    /**
     * Brief article summary or lede, if available.
     * May be an empty string when the source does not provide summaries.
     */
    summary: string;
    /** Name of the news source (e.g. `"Reuters"`, `"MarketWatch"`). */
    source: string;
    /**
     * Unix timestamp (seconds) when the article was published.
     * Use `new Date(datetime * 1000)` to convert to a JS `Date`.
     */
    datetime: number;
    /** Canonical URL of the full article. */
    url: string;
    /**
     * Comma-separated ticker symbols related to this article
     * (e.g. `"AAPL,MSFT"`), as returned by Finnhub.
     * May be an empty string for general market news.
     */
    related: string;
}
/**
 * A single entry in the user's watchlist.
 *
 * Persisted in {@link ToolState.watchlist}. The `isIndex` flag drives
 * threshold selection — index symbols use {@link Settings.notableThresholdIndex}
 * whereas individual stocks use {@link Settings.notableThresholdStock}.
 *
 * v1 note: `type: "crypto"` is included for forward-compatibility but crypto
 * symbols are excluded from the default watchlist and market-hours logic in
 * the initial release. Crypto items always poll at the market-open interval.
 */
export interface WatchlistItem {
    /** Ticker symbol as understood by Finnhub (e.g. `"AAPL"`, `"SPY"`). */
    symbol: string;
    /**
     * Human-readable display name.
     * For ETF proxies used as index stand-ins, this should include both the
     * ETF ticker and the index name (e.g. `"S&P 500 (SPY)"`).
     */
    name: string;
    /**
     * Exchange or market the symbol trades on (e.g. `"US"`, `"LSE"`, `"TSX"`).
     * Matches the exchange codes used in {@link MarketStatus.exchange}.
     */
    exchange: string;
    /**
     * Classification of the symbol.
     * - `"stock"` — individual equity
     * - `"etf"` — exchange-traded fund (including index-proxy ETFs like SPY)
     * - `"index"` — direct index symbol (e.g. Finnhub-native index identifiers)
     * - `"crypto"` — cryptocurrency (24/7 trading; v2 feature)
     */
    type: "stock" | "etf" | "index" | "crypto";
    /**
     * ISO 8601 datetime string when the user added this symbol to their watchlist.
     * Set to `""` for items inserted before timestamp tracking was introduced.
     */
    addedAt: string;
    /**
     * When `true`, this item is treated as a broad market index and uses
     * {@link Settings.notableThresholdIndex} for alert evaluation.
     * When `false`, it uses {@link Settings.notableThresholdStock}.
     *
     * Set to `true` for items with `type: "index"` and for ETF proxies that
     * represent major indices (SPY, QQQ, DIA).
     */
    isIndex: boolean;
}
/**
 * A user-configured price threshold alert for a specific symbol.
 *
 * When the live price crosses `targetPrice` in the specified `direction`,
 * the daemon injects a prompt message into Chalie's reasoning queue and
 * marks `triggeredAt` with the current ISO timestamp.
 *
 * Alerts remain in state after triggering (`active: false`) so the user can
 * review or re-activate them.
 */
export interface PriceAlert {
    /**
     * Unique identifier for this alert.
     * Generated via `crypto.randomUUID()` at creation time.
     */
    id: string;
    /** Ticker symbol this alert monitors. */
    symbol: string;
    /**
     * The price level that triggers this alert (in USD for US equities).
     * Compared against {@link Quote.price} on each sync cycle.
     */
    targetPrice: number;
    /**
     * Direction of the crossing that activates the alert.
     * - `"above"` — fires when `price >= targetPrice` after having been below
     * - `"below"` — fires when `price <= targetPrice` after having been above
     */
    direction: "above" | "below";
    /**
     * Optional custom message to include in the alert notification.
     * When empty, a default message is generated from `symbol`, `targetPrice`,
     * and `direction`.
     */
    message: string;
    /**
     * ISO 8601 datetime string when the user created this alert.
     * Used for display and audit purposes.
     */
    createdAt: string;
    /**
     * ISO 8601 datetime string when this alert was last triggered, or `null`
     * if it has never fired. A non-null value with `active: false` means the
     * alert has been consumed and is awaiting user review or re-activation.
     */
    triggeredAt: string | null;
    /**
     * Whether this alert is actively monitored.
     * Set to `false` after the alert fires. Users can re-enable it via the UI.
     */
    active: boolean;
}
/**
 * The complete persisted state blob for the stocks-interface Chalie tool.
 *
 * Serialised as JSON and stored in Chalie's `_state` field (tool contract).
 * Read at daemon startup; written after every sync cycle and capability
 * execution that mutates state.
 *
 * All nullable fields default to `null` on first run before meaningful data
 * has been collected.
 */
export interface ToolState {
    /** Finnhub API key entered by the user during setup. Empty string if not yet configured. */
    apiKey: string;
    /**
     * The user's current watchlist, ordered as displayed in the UI.
     * Defaults to the three index-proxy ETFs (SPY, QQQ, DIA) on first run.
     */
    watchlist: WatchlistItem[];
    /** Active and recently triggered price alerts. */
    priceAlerts: PriceAlert[];
    /**
     * ISO 8601 datetime string of the last successful quote sync, or `null`
     * before the first sync completes. Displayed in the UI header as
     * "Last updated: …".
     */
    lastSyncAt: string | null;
    /**
     * ISO 8601 date string (`"YYYY-MM-DD"`) of the last day a market-close
     * summary signal was emitted, or `null` before any summary has been sent.
     * Used to prevent duplicate summaries within a single trading day, and to
     * detect that a summary is due when the daemon starts after market close.
     */
    lastMarketSummaryDate: string | null;
    /**
     * The market state observed on the most recent status poll.
     * Used to detect state transitions (e.g. `"pre"` → `"open"`) and drive
     * polling-interval changes without an extra API call.
     * `null` before the first status check.
     */
    lastKnownMarketState: "open" | "pre" | "after" | "closed" | null;
    /**
     * Rolling log of recently fired signal keys used for deduplication.
     *
     * Each entry has the form `symbol:signalType:thresholdBracket`
     * (e.g. `"TSLA:stock_alert:gt5pct"`) and the Unix millisecond timestamp
     * when it was emitted. Entries older than 2 hours are pruned on each sync
     * cycle to bound memory usage.
     */
    dedupHistory: Array<{
        /** Deduplication key in the format `symbol:signalType:thresholdBracket`. */
        key: string;
        /** Unix millisecond timestamp when this signal was emitted. */
        firedAt: number;
    }>;
}
/**
 * User-configurable settings for the stocks-interface tool.
 *
 * Stored as part of {@link ToolState} (or as a separate settings blob, depending
 * on the Chalie tool contract version). All values have sensible defaults that
 * are applied when the key is absent from persisted state.
 *
 * Threshold values are percentages expressed as plain numbers (e.g. `2` = 2%).
 * Interval values are in milliseconds.
 */
export interface Settings {
    /**
     * Quote sync interval in milliseconds while the market is open.
     * Default: `120000` (2 minutes). Must be ≥ 60 000 ms to respect the
     * Finnhub free-tier rate limit of 60 req/min.
     */
    syncIntervalMarketOpen: number;
    /**
     * Quote sync interval in milliseconds while the market is closed
     * (pre-market, after-hours, weekends, and holidays).
     * Default: `300000` (5 minutes). Reduced polling saves API quota overnight.
     */
    syncIntervalMarketClosed: number;
    /**
     * Percentage move threshold for individual stocks before a signal is emitted.
     * A value of `2` means a ±2% intraday move triggers a `stock_move` signal;
     * ±(2 × 2.5) = ±5% triggers a `stock_alert` signal.
     * Default: `2`.
     */
    notableThresholdStock: number;
    /**
     * Percentage move threshold for broad market indices and index-proxy ETFs.
     * Typically set lower than {@link notableThresholdStock} because index moves
     * are inherently smaller in magnitude than individual stock moves.
     * Default: `0.5`.
     */
    notableThresholdIndex: number;
    /**
     * Maximum number of symbols allowed in the watchlist.
     * Hard ceiling enforced by the add-symbol UI and capabilities.
     * Default: `30`. Higher values increase API quota consumption proportionally.
     */
    maxWatchlistSize: number;
}
//# sourceMappingURL=types.d.ts.map