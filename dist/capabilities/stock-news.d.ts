/**
 * @file src/capabilities/stock-news.ts
 * @description Capability handler that fetches and renders recent company news
 * for a single symbol.
 *
 * Invoked by the Chalie reasoning layer when the user asks for news about a
 * specific stock (e.g. "What's the latest news on Tesla?").
 *
 * ## Data sources
 * - **Company news** — `GET /company-news` via {@link FinnhubClient.news},
 *   fetching the trailing 7-day window. One API call per invocation (priority
 *   tier 4 — background, deferrable).
 *
 * ## Limit semantics
 * - Default limit: {@link DEFAULT_LIMIT} (5 articles)
 * - Maximum limit: {@link MAX_LIMIT} (10 articles)
 * - Caller-supplied `limit` values above {@link MAX_LIMIT} are silently capped.
 *
 * ## Date window
 * News is always fetched for the trailing 7 calendar days from the current UTC
 * date. This window is a fixed design choice that keeps the API request
 * consistent without requiring the caller to supply date parameters.
 *
 * @module stocks-interface/capabilities/stock-news
 */
import type { FinnhubClient } from "../finnhub/client.js";
import type { ToolState } from "../finnhub/types.js";
import type { CapabilityResult } from "./stock-quote.js";
/**
 * Fetches recent company news for a single symbol and returns a formatted
 * news card alongside a plain-text summary.
 *
 * ### HTML card contents
 * - Card header with symbol name and article count
 * - Up to {@link MAX_LIMIT} news items, each showing:
 *   - Clickable headline (links to the full article)
 *   - Source name
 *   - Formatted publication date
 *
 * ### Empty-result handling
 * When Finnhub returns zero articles for the trailing 7-day window, a
 * user-friendly "No recent news found" message is returned without setting
 * the `error` field (empty results are expected for some symbols).
 *
 * ### Error handling
 * On any Finnhub error the function resolves (not rejects) with a
 * {@link CapabilityResult} that has `error` set and a user-facing HTML message.
 *
 * @param params         - Handler parameters.
 * @param params.symbol  - Ticker symbol to look up (case-insensitive;
 *   normalised to upper-case internally).
 * @param params.limit   - Maximum number of articles to return. Defaults to
 *   {@link DEFAULT_LIMIT} (5). Capped at {@link MAX_LIMIT} (10).
 * @param client         - Configured {@link FinnhubClient} instance.
 * @param _state         - Current {@link ToolState}. Accepted for interface
 *   consistency with other capability handlers; not used by this handler.
 * @returns A resolved {@link CapabilityResult} — never rejects.
 *
 * @example
 * ```ts
 * const result = await handleStockNews({ symbol: "TSLA", limit: 5 }, client, state);
 * console.log(result.text);
 * // "Recent news for TSLA (5 articles): "Tesla Earnings Beat..." (Reuters, Jan 15, 2026) | ..."
 * ```
 */
export declare function handleStockNews(params: {
    symbol: string;
    limit?: number;
}, client: FinnhubClient, _state: ToolState): Promise<CapabilityResult>;
//# sourceMappingURL=stock-news.d.ts.map