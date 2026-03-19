# Stocks Interface for Chalie

Real-time stock market data, watchlist management, and price alerts powered by
[Finnhub](https://finnhub.io).

## Prerequisites

- **Deno 1.44+** — see the
  [installation guide](https://deno.com/manual/getting_started/installation)

## Finnhub API Key

This tool requires a free Finnhub API key.

1. Sign up at <https://finnhub.io> and copy your API key from the dashboard.
2. Open Chalie's **tool-settings panel** for _Stocks Interface_.
3. Paste the key into the **API Key** field and save.

The key is stored securely by the Chalie runtime and injected at invocation
time. Do **not** set it via an environment variable or config file.

## Setup

```sh
# Type-check the project
deno task check

# Run the test suite
deno task test

# Start the daemon (IPC mode, used by the Chalie runtime)
deno task dev

# Format all source files
deno task fmt
```

## Capabilities

Invoke each capability by passing its name as the `capability` parameter.

### `stock_quote`

Fetch a real-time quote for a single ticker.

| Parameter | Type   | Required | Description                 |
| --------- | ------ | -------- | --------------------------- |
| `symbol`  | string | ✅       | Ticker symbol (e.g. `AAPL`) |

**Example prompt:** _"What is Apple's current stock price?"_

---

### `stock_compare`

Side-by-side comparison of multiple tickers.

| Parameter | Type   | Required | Description                                      |
| --------- | ------ | -------- | ------------------------------------------------ |
| `symbols` | string | ✅       | Comma-separated tickers (e.g. `AAPL,MSFT,GOOGL`) |

**Example prompt:** _"Compare Apple, Microsoft, and Google."_

---

### `stock_history`

Historical price chart for a single ticker.

| Parameter | Type   | Required | Description                             |
| --------- | ------ | -------- | --------------------------------------- |
| `symbol`  | string | ✅       | Ticker symbol                           |
| `period`  | string | ✅       | One of: `7d`, `30d`, `90d`, `1y`, `ytd` |

**Example prompt:** _"Show Tesla's price history for the past 30 days."_

---

### `stock_news`

Latest news articles for a ticker.

| Parameter | Type    | Required | Description                             |
| --------- | ------- | -------- | --------------------------------------- |
| `symbol`  | string  | ✅       | Ticker symbol                           |
| `limit`   | integer | ❌       | Maximum number of articles (default: 5) |

**Example prompt:** _"Show me the latest 10 news articles for NVDA."_

---

### `market_status`

Current status of major market indices and trading hours.

_No additional parameters required._

**Example prompt:** _"Is the market open right now?"_

---

### `earnings_calendar`

Upcoming earnings announcements.

| Parameter   | Type    | Required | Description                              |
| ----------- | ------- | -------- | ---------------------------------------- |
| `daysAhead` | integer | ❌       | Calendar days to look ahead (default: 7) |

**Example prompt:** _"What earnings are coming up in the next two weeks?"_

---

### `watchlist_add`

Add a symbol to your personal watchlist.

| Parameter | Type   | Required | Description                                        |
| --------- | ------ | -------- | -------------------------------------------------- |
| `symbol`  | string | ✅       | Ticker symbol                                      |
| `type`    | string | ❌       | Symbol type hint — one of: `stock`, `etf`, `index` |

**Example prompt:** _"Add SPY to my watchlist."_

---

### `watchlist_remove`

Remove a symbol from your personal watchlist.

| Parameter | Type   | Required | Description   |
| --------- | ------ | -------- | ------------- |
| `symbol`  | string | ✅       | Ticker symbol |

**Example prompt:** _"Remove TSLA from my watchlist."_

---

### `alert_set`

Create a price alert that fires when a symbol crosses a target level.

| Parameter     | Type   | Required | Description                                  |
| ------------- | ------ | -------- | -------------------------------------------- |
| `symbol`      | string | ✅       | Ticker symbol                                |
| `targetPrice` | float  | ✅       | Price level to monitor                       |
| `direction`   | string | ✅       | Trigger direction — one of: `above`, `below` |
| `message`     | string | ❌       | Optional custom note attached to the alert   |

**Example prompt:** _"Alert me when AAPL goes above $220."_

---

### `alert_list`

List all active price alerts.

_No additional parameters required._

**Example prompt:** _"Show my active price alerts."_

---

### `alert_delete`

Delete a price alert by its ID.

| Parameter | Type   | Required | Description               |
| --------- | ------ | -------- | ------------------------- |
| `alertId` | string | ✅       | ID of the alert to delete |

**Example prompt:** _"Delete alert abc-123."_

---

## Suggested Prompts

- _"What's the market doing today?"_
- _"Show me my watchlist."_
- _"Compare AAPL, MSFT, and AMZN."_
- _"Alert me when NVDA drops below $100."_
- _"What earnings reports are coming up this week?"_
- _"Show Tesla's price chart for the last year."_

## Architecture

The tool is implemented in **Deno** (TypeScript). The Chalie runtime invokes
`src/index.ts` with a base64-encoded JSON payload in `Deno.args[0]` and reads a
single-line JSON response from stdout. When the `STOCKS_DAEMON` environment
variable is set to `1`, the process also starts a background market-sync loop
that fetches quotes at configurable intervals and emits signals for notable
price movements and triggered alerts.

```
src/
  index.ts              Entry point — IPC dispatch + daemon lifecycle
  state.ts              State persistence (atomic JSON writes)
  finnhub/              Finnhub API client with rate limiting and caching
  sync/                 Market-sync loop and alert evaluation
  capabilities/         One handler per tool capability
  ui/                   HTML renderers (watchlist, quotes, setup)
tests/
  unit/                 Deno-native unit tests (deno task test)
```
