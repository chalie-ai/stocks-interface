/**
 * @file tests/unit/alerts.test.ts
 * @description Unit tests for {@link checkAlerts} and {@link formatAlertMessage}
 * from src/sync/alerts.ts.
 *
 * All tests are pure (no network calls, no file I/O).  Fixtures are built
 * with the helpers at the top of this file.
 *
 * ## Test coverage
 * 1. `checkAlerts` fires when price crosses an "above" threshold.
 * 2. `checkAlerts` fires when price crosses a "below" threshold.
 * 3. `checkAlerts` does NOT fire when the price has not crossed the threshold.
 * 4. A triggered alert is marked `active: false` and `triggeredAt` is stamped.
 * 5. `formatAlertMessage` produces the correct text without a custom message.
 * 6. `formatAlertMessage` appends a custom message when one is provided.
 */

import { describe, it } from "jsr:@std/testing/bdd";
import { expect } from "jsr:@std/expect";
import { checkAlerts, formatAlertMessage } from "../../src/sync/alerts.ts";
import type {
  PriceAlert,
  Quote,
  Settings,
  ToolState,
} from "../../src/finnhub/types.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/**
 * The default {@link Settings} applied to every test-state fixture.
 * Values are arbitrary; only `priceAlerts` affects alert evaluation.
 */
const DEFAULT_SETTINGS: Settings = {
  syncIntervalMarketOpen: 120_000,
  syncIntervalMarketClosed: 300_000,
  notableThresholdStock: 2,
  notableThresholdIndex: 0.5,
  maxWatchlistSize: 30,
};

/**
 * Builds a minimal {@link ToolState} populated with the provided alerts.
 *
 * All other state fields are set to inert defaults so tests can focus
 * exclusively on the `priceAlerts` array.
 *
 * @param alerts - Price alerts to include in the returned state.
 * @returns A {@link ToolState} ready for use in `checkAlerts` calls.
 */
function makeState(alerts: PriceAlert[] = []): ToolState {
  return {
    apiKey: "test-key",
    watchlist: [],
    priceAlerts: alerts,
    lastSyncAt: null,
    lastMarketSummaryDate: null,
    lastKnownMarketState: null,
    dedupHistory: [],
    settings: DEFAULT_SETTINGS,
  };
}

/**
 * Builds a {@link Quote} for the given symbol and price.
 *
 * `changePercent` defaults to `0`; all price fields are set to the provided
 * `price` so tests need only specify the fields they care about.
 *
 * @param symbol        - Ticker symbol (e.g. `"AAPL"`).
 * @param price         - Current price to embed in the quote.
 * @param changePercent - Intraday percentage change; defaults to `0`.
 * @returns A fully-populated {@link Quote} fixture.
 */
function makeQuote(symbol: string, price: number, changePercent = 0): Quote {
  return {
    symbol,
    name: null,
    price,
    change: 0,
    changePercent,
    high: price,
    low: price,
    open: price,
    previousClose: price,
    timestamp: Math.floor(Date.now() / 1_000),
    volume: 1_000_000,
  };
}

/**
 * Builds a {@link PriceAlert} with sensible defaults, optionally overridden
 * by the caller.
 *
 * @param overrides - Partial alert fields that override the defaults.
 * @returns A {@link PriceAlert} fixture.
 */
function makeAlert(overrides: Partial<PriceAlert> = {}): PriceAlert {
  return {
    id: "alert-test-id",
    symbol: "AAPL",
    targetPrice: 200,
    direction: "above",
    message: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    triggeredAt: null,
    active: true,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// describe: checkAlerts
// ---------------------------------------------------------------------------

describe("checkAlerts", () => {
  /**
   * Verifies that an "above" alert fires when the current price is at or above
   * the target, using an exact match (`price === targetPrice`).
   *
   * Both equality and strict-above should trigger the alert.  This test covers
   * the equality edge-case (`>=`).
   */
  it("fires an 'above' alert when price equals the target", () => {
    const alert = makeAlert({
      symbol: "AAPL",
      targetPrice: 200,
      direction: "above",
    });
    const state = makeState([alert]);
    const quotes = new Map([["AAPL", makeQuote("AAPL", 200)]]);

    const { triggered } = checkAlerts(state, quotes);

    expect(triggered).toHaveLength(1);
    expect(triggered[0]!.symbol).toBe("AAPL");
    expect(triggered[0]!.direction).toBe("above");
  });

  /**
   * Verifies that an "above" alert fires when the current price is strictly
   * greater than the target.
   */
  it("fires an 'above' alert when price exceeds the target", () => {
    const alert = makeAlert({
      symbol: "TSLA",
      targetPrice: 300,
      direction: "above",
    });
    const state = makeState([alert]);
    const quotes = new Map([["TSLA", makeQuote("TSLA", 315.75)]]);

    const { triggered } = checkAlerts(state, quotes);

    expect(triggered).toHaveLength(1);
    expect(triggered[0]!.symbol).toBe("TSLA");
  });

  /**
   * Verifies that a "below" alert fires when the current price is at or below
   * the target, using a strict-below scenario.
   */
  it("fires a 'below' alert when price drops under the target", () => {
    const alert = makeAlert({
      symbol: "MSFT",
      targetPrice: 400,
      direction: "below",
    });
    const state = makeState([alert]);
    const quotes = new Map([["MSFT", makeQuote("MSFT", 395.5)]]);

    const { triggered } = checkAlerts(state, quotes);

    expect(triggered).toHaveLength(1);
    expect(triggered[0]!.symbol).toBe("MSFT");
    expect(triggered[0]!.direction).toBe("below");
  });

  /**
   * Verifies that an "above" alert does NOT fire when the current price is
   * below the target — i.e. the threshold has not yet been crossed.
   */
  it("does NOT fire when price is below an 'above' target", () => {
    const alert = makeAlert({
      symbol: "AAPL",
      targetPrice: 220,
      direction: "above",
    });
    const state = makeState([alert]);
    const quotes = new Map([["AAPL", makeQuote("AAPL", 199.99)]]);

    const { triggered } = checkAlerts(state, quotes);

    expect(triggered).toHaveLength(0);
  });

  /**
   * Verifies that a "below" alert does NOT fire when the current price is
   * above the target — i.e. the threshold has not yet been crossed downward.
   */
  it("does NOT fire when price is above a 'below' target", () => {
    const alert = makeAlert({
      symbol: "GOOGL",
      targetPrice: 150,
      direction: "below",
    });
    const state = makeState([alert]);
    const quotes = new Map([["GOOGL", makeQuote("GOOGL", 175)]]);

    const { triggered } = checkAlerts(state, quotes);

    expect(triggered).toHaveLength(0);
  });

  /**
   * Verifies that triggered alerts are marked `active: false` in the returned
   * `updatedState`, and that `triggeredAt` is a non-empty ISO string.
   *
   * The original `state` must remain unmodified (immutability contract).
   */
  it("marks triggered alerts as inactive with a triggeredAt timestamp", () => {
    const alert = makeAlert({
      symbol: "AAPL",
      targetPrice: 180,
      direction: "above",
    });
    const state = makeState([alert]);
    const quotes = new Map([["AAPL", makeQuote("AAPL", 200, 3.5)]]);

    const { triggered, updatedState } = checkAlerts(state, quotes);

    // Alert fired.
    expect(triggered).toHaveLength(1);

    // Returned triggered item is inactive with a timestamp.
    const fired = triggered[0]!;
    expect(fired.active).toBe(false);
    expect(typeof fired.triggeredAt).toBe("string");
    expect(fired.triggeredAt!.length).toBeGreaterThan(0);

    // updatedState reflects the deactivation.
    const updatedAlert = updatedState.priceAlerts[0]!;
    expect(updatedAlert.active).toBe(false);
    expect(updatedAlert.triggeredAt).toBe(fired.triggeredAt);

    // Original state is NOT mutated.
    expect(state.priceAlerts[0]!.active).toBe(true);
    expect(state.priceAlerts[0]!.triggeredAt).toBeNull();
  });

  /**
   * Verifies that inactive alerts (already fired) are silently skipped and
   * do not appear in the `triggered` array.
   */
  it("skips already-inactive alerts", () => {
    const alert = makeAlert({
      symbol: "AAPL",
      targetPrice: 100,
      direction: "above",
      active: false,
      triggeredAt: "2026-01-01T10:00:00.000Z",
    });
    const state = makeState([alert]);
    // Price is well above target, but alert is already inactive.
    const quotes = new Map([["AAPL", makeQuote("AAPL", 220)]]);

    const { triggered } = checkAlerts(state, quotes);

    expect(triggered).toHaveLength(0);
  });

  /**
   * Verifies that alerts for symbols not present in the quotes map are skipped
   * gracefully — no throw, no spurious trigger.
   */
  it("skips alerts for symbols missing from the quotes map", () => {
    const alert = makeAlert({
      symbol: "NVDA",
      targetPrice: 800,
      direction: "above",
    });
    const state = makeState([alert]);
    // No quote for NVDA.
    const quotes = new Map<string, Quote>();

    const { triggered } = checkAlerts(state, quotes);

    expect(triggered).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// describe: formatAlertMessage
// ---------------------------------------------------------------------------

describe("formatAlertMessage", () => {
  /**
   * Verifies the standard message format when no custom `message` is provided.
   *
   * Expected format:
   * ```
   * Price alert: AAPL has crossed above $200.00, now at $201.30 (+1.8% today).
   * ```
   */
  it("produces the correct message for an 'above' alert without custom text", () => {
    const alert = makeAlert({
      symbol: "AAPL",
      targetPrice: 200,
      direction: "above",
      message: "",
    });
    const quote = makeQuote("AAPL", 201.3, 1.8);

    const msg = formatAlertMessage(alert, quote);

    expect(msg).toBe(
      "Price alert: AAPL has crossed above $200.00, now at $201.30 (+1.8% today).",
    );
  });

  /**
   * Verifies the standard message format for a "below" direction trigger.
   *
   * Expected format:
   * ```
   * Price alert: MSFT has crossed below $400.00, now at $391.50 (-3.2% today).
   * ```
   */
  it("produces the correct message for a 'below' alert without custom text", () => {
    const alert = makeAlert({
      symbol: "MSFT",
      targetPrice: 400,
      direction: "below",
      message: "",
    });
    const quote = makeQuote("MSFT", 391.5, -3.2);

    const msg = formatAlertMessage(alert, quote);

    expect(msg).toBe(
      "Price alert: MSFT has crossed below $400.00, now at $391.50 (-3.2% today).",
    );
  });

  /**
   * Verifies that when a non-empty `message` is set on the alert, it is
   * appended (with a single space separator) after the generated sentence.
   *
   * Expected format:
   * ```
   * Price alert: TSLA has crossed above $300.00, now at $310.00 (+0.0% today). Time to review!
   * ```
   */
  it("appends the custom message when the alert has non-empty message text", () => {
    const alert = makeAlert({
      symbol: "TSLA",
      targetPrice: 300,
      direction: "above",
      message: "Time to review!",
    });
    const quote = makeQuote("TSLA", 310, 0);

    const msg = formatAlertMessage(alert, quote);

    expect(msg).toContain("Time to review!");
    expect(msg).toBe(
      "Price alert: TSLA has crossed above $300.00, now at $310.00 (+0.0% today). Time to review!",
    );
  });

  /**
   * Verifies that the custom message field is trimmed before appending, so
   * leading/trailing whitespace in user-supplied text does not produce
   * double spaces or trailing whitespace in the output.
   */
  it("trims whitespace from the custom message before appending", () => {
    const alert = makeAlert({
      symbol: "AAPL",
      targetPrice: 150,
      direction: "below",
      message: "  Buy the dip!  ",
    });
    const quote = makeQuote("AAPL", 148, -1.3);

    const msg = formatAlertMessage(alert, quote);

    expect(msg).toContain("Buy the dip!");
    // No double-space before the custom text.
    expect(msg).not.toMatch(/\s{2,}/);
    expect(msg.endsWith("Buy the dip!")).toBe(true);
  });
});
