/**
 * @file daemon.ts
 * @description SDK daemon entry point for the stocks-interface.
 *
 * Bridges the existing capability handlers to the Chalie Interface SDK's
 * daemon model so the interface_daemon_worker can auto-discover and manage
 * this interface.
 *
 * The daemon worker finds this file at the repo root and starts it with:
 *   deno run --allow-net --allow-read --allow-write --allow-env \
 *     daemon.ts --gateway=<url> --port=<port> --data-dir=<dir>
 *
 * The SDK's `createDaemon()` parses `--gateway` and `--port`. This file
 * parses `--data-dir` to locate the state directory for `loadState`/`saveState`.
 *
 * @module stocks-interface/daemon
 */

import {
  createDaemon,
  sendSignal,
  sendMessage,
} from "jsr:@chalie/interface-sdk@^1.1.0";

import { FinnhubClient } from "./src/finnhub/client.ts";
import { loadState, saveState } from "./src/state.ts";
import { MarketSync } from "./src/sync/market-sync.ts";
import type { StopFn } from "./src/sync/market-sync.ts";
import { renderMainView } from "./src/ui/main.ts";
import { renderSetupPage } from "./src/ui/setup.ts";
import type { Block } from "../_sdk/blocks.ts";
import type { ToolState, WatchlistItem, Quote } from "./src/finnhub/types.ts";
import type {
  AlertDeleteParams,
  AlertSetParams,
  CapabilityResult,
  HistoryPeriod,
} from "./src/capabilities/index.ts";
import {
  handleAlertDelete,
  handleAlertList,
  handleAlertSet,
  handleEarningsCalendar,
  handleMarketStatus,
  handleStockCompare,
  handleStockHistory,
  handleStockNews,
  handleStockQuote,
  handleWatchlistAdd,
  handleWatchlistRemove,
} from "./src/capabilities/index.ts";

// ---------------------------------------------------------------------------
// CLI arg parsing
// ---------------------------------------------------------------------------

function parseCliArg(prefix: string): string | undefined {
  for (const arg of Deno.args) {
    if (arg.startsWith(prefix)) {
      return arg.slice(prefix.length);
    }
  }
  return undefined;
}

const dataDir = parseCliArg("--data-dir=") ??
  (() => {
    const home = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "/";
    return `${home}/.chalie/stocks-interface`;
  })();

// ---------------------------------------------------------------------------
// Daemon state
// ---------------------------------------------------------------------------

let state: ToolState = await loadState(dataDir);
let client: FinnhubClient | null = state.apiKey
  ? new FinnhubClient(state.apiKey)
  : null;
let stopSync: StopFn | null = null;

// ---------------------------------------------------------------------------
// Background sync
// ---------------------------------------------------------------------------

function startSyncLoop(): void {
  if (!client || state.watchlist.length === 0 || stopSync) return;

  const sync = new MarketSync();
  stopSync = sync.startSync(
    state,
    client,
    (signal) => {
      void sendSignal("market_data", {
        type: signal.type,
        symbol: signal.symbol,
        name: signal.name,
        energy: signal.energy,
        content: signal.content,
      });
    },
    (quotes) => {
      const lines = quotes.map((q) =>
        `${q.name || q.symbol}: $${q.price.toFixed(2)}`
      ).join(", ");
      void sendMessage(`Market close summary: ${lines}`, "market_data");
    },
    async () => {
      await saveState(dataDir, state);
    },
  );
}

if (client) {
  startSyncLoop();
}

// ---------------------------------------------------------------------------
// Daemon registration
// ---------------------------------------------------------------------------

createDaemon({
  name: "Stocks Interface",
  version: "0.1.0",
  description:
    "Real-time stock market data, watchlist management, and price alerts powered by Finnhub",
  author: "Chalie",

  scopes: {
    signals: {
      market_data: "Stock and market price signals",
    },
    messages: {
      market_data: "Stock and market notifications",
    },
  },

  capabilities: [
    {
      name: "stock_quote",
      description: "Get a real-time stock quote",
      parameters: [
        {
          name: "symbol",
          type: "string",
          description: "Ticker symbol (e.g. AAPL)",
          required: true,
        },
      ],
    },
    {
      name: "stock_compare",
      description: "Compare multiple stocks side by side",
      parameters: [
        {
          name: "symbols",
          type: "string",
          description: "Comma-separated ticker symbols",
          required: true,
        },
      ],
    },
    {
      name: "stock_history",
      description: "Get historical price data",
      parameters: [
        {
          name: "symbol",
          type: "string",
          description: "Ticker symbol",
          required: true,
        },
        {
          name: "period",
          type: "string",
          description: "Period: 7d, 30d, 90d, 1y, ytd",
          required: false,
        },
      ],
    },
    {
      name: "stock_news",
      description: "Get latest news for a stock",
      parameters: [
        {
          name: "symbol",
          type: "string",
          description: "Ticker symbol",
          required: true,
        },
        {
          name: "limit",
          type: "number",
          description: "Max articles to return",
          required: false,
        },
      ],
    },
    {
      name: "market_status",
      description: "Check if the US stock market is open or closed",
      parameters: [],
    },
    {
      name: "earnings_calendar",
      description: "Get upcoming earnings reports",
      parameters: [
        {
          name: "symbol",
          type: "string",
          description: "Filter by ticker symbol",
          required: false,
        },
        {
          name: "daysAhead",
          type: "number",
          description: "Days ahead to check",
          required: false,
        },
      ],
    },
    {
      name: "watchlist_add",
      description: "Add a stock to the watchlist",
      parameters: [
        {
          name: "symbol",
          type: "string",
          description: "Ticker symbol to add",
          required: true,
        },
        {
          name: "type",
          type: "string",
          description: "Symbol type: stock, etf, index",
          required: false,
        },
      ],
    },
    {
      name: "watchlist_remove",
      description: "Remove a stock from the watchlist",
      parameters: [
        {
          name: "symbol",
          type: "string",
          description: "Ticker symbol to remove",
          required: true,
        },
      ],
    },
    {
      name: "alert_set",
      description: "Set a price alert for a stock",
      parameters: [
        {
          name: "symbol",
          type: "string",
          description: "Ticker symbol",
          required: true,
        },
        {
          name: "targetPrice",
          type: "number",
          description: "Target price level",
          required: true,
        },
        {
          name: "direction",
          type: "string",
          description: "above or below",
          required: true,
        },
        {
          name: "message",
          type: "string",
          description: "Custom note",
          required: false,
        },
      ],
    },
    {
      name: "alert_list",
      description: "List all active price alerts",
      parameters: [],
    },
    {
      name: "alert_delete",
      description: "Delete a price alert",
      parameters: [
        {
          name: "alertId",
          type: "string",
          description: "Alert ID to delete",
          required: true,
        },
      ],
    },
  ],

  polls: [],

  async executeCommand(capability: string, params: Record<string, unknown>) {
    // Setup capability — validate and save API key (no client required)
    if (capability === "_setup_save_key") {
      const apiKey = ((params.api_key as string) ?? "").trim();
      if (!apiKey) {
        return {
          text: null,
          data: null,
          blocks: renderSetupPage({ type: "auth", message: "No key provided" }),
        };
      }

      const testClient = new FinnhubClient(apiKey);
      try {
        await testClient.quote("AAPL");
        // Valid key — persist and switch to main view
        state.apiKey = apiKey;
        await saveState(dataDir, state);
        client = testClient;
        startSyncLoop();
        return {
          text: "Connected to Finnhub!",
          data: null,
          blocks: renderMainView(state, null, "loading"),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("401") || msg.toLowerCase().includes("unauthorized")) {
          return {
            text: null,
            data: null,
            blocks: renderSetupPage({ type: "auth", message: msg }),
          };
        }
        // Network / service error — save key optimistically
        state.apiKey = apiKey;
        await saveState(dataDir, state);
        client = testClient;
        return {
          text: null,
          data: null,
          blocks: renderSetupPage({ type: "service", message: msg }),
        };
      }
    }

    // Ensure client is initialised (API key may have been set via meta since startup)
    if (!client) {
      state = await loadState(dataDir);
      if (state.apiKey) {
        client = new FinnhubClient(state.apiKey);
        startSyncLoop();
      } else {
        return {
          text:
            "Finnhub API key required. Configure your key to enable live market data.",
          data: null,
          error: "No API key configured",
        };
      }
    }

    try {
      let result: CapabilityResult;
      let updatedState: ToolState | null = null;

      switch (capability) {
        case "stock_quote":
          result = await handleStockQuote(
            params as unknown as { symbol: string },
            client,
            state,
          );
          break;

        case "stock_compare": {
          const raw = params.symbols as string;
          const symbols = raw.split(",").map((s) => s.trim()).filter(Boolean);
          result = await handleStockCompare({ symbols }, client, state);
          break;
        }

        case "stock_history":
          result = await handleStockHistory(
            params as unknown as { symbol: string; period: HistoryPeriod },
            client,
            state,
          );
          break;

        case "stock_news":
          result = await handleStockNews(
            params as unknown as { symbol: string; limit?: number },
            client,
            state,
          );
          break;

        case "market_status":
          result = await handleMarketStatus(
            {} as Record<string, never>,
            client,
            state,
          );
          break;

        case "earnings_calendar":
          result = await handleEarningsCalendar(
            params as unknown as { symbol?: string; daysAhead?: number },
            client,
            state,
          );
          break;

        case "watchlist_add": {
          const wAdd = await handleWatchlistAdd(
            params as unknown as {
              symbol: string;
              type?: WatchlistItem["type"];
            },
            client,
            state,
          );
          result = wAdd.result;
          updatedState = wAdd.updatedState;
          break;
        }

        case "watchlist_remove": {
          const wRemove = handleWatchlistRemove(
            params as unknown as { symbol: string },
            state,
          );
          result = wRemove.result;
          updatedState = wRemove.updatedState;
          break;
        }

        case "alert_set": {
          const aSet = handleAlertSet(
            params as unknown as AlertSetParams,
            state,
          );
          result = aSet.result;
          updatedState = aSet.updatedState;
          break;
        }

        case "alert_list":
          result = handleAlertList({} as Record<string, never>, state);
          break;

        case "alert_delete": {
          const aDel = handleAlertDelete(
            params as unknown as AlertDeleteParams,
            state,
          );
          result = aDel.result;
          updatedState = aDel.updatedState;
          break;
        }

        default:
          return {
            text: `Unknown capability: ${capability}`,
            data: null,
            error: `Unknown capability: ${capability}`,
          };
      }

      // Persist mutated state
      if (updatedState) {
        state = updatedState;
        await saveState(dataDir, state);
        // Start sync if watchlist gained its first item
        if (capability === "watchlist_add" && !stopSync) {
          startSyncLoop();
        }
      }

      return { text: result.text, html: result.html, data: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { text: message, data: null, error: message };
    }
  },

  async renderInterface(): Promise<Block[]> {
    state = await loadState(dataDir);

    if (!state.apiKey) {
      return renderSetupPage();
    }

    if (!client) {
      client = new FinnhubClient(state.apiKey);
    }

    if (state.watchlist.length === 0) {
      return renderMainView(state, null, "empty");
    }

    // Fetch live quotes for the dashboard
    try {
      const quoteMap = new Map<string, Quote>();
      for (const item of state.watchlist) {
        try {
          const q = await client.quote(item.symbol);
          quoteMap.set(item.symbol, q);
        } catch {
          // Skip individual failures
        }
      }
      return renderMainView(
        state,
        quoteMap,
        quoteMap.size > 0 ? "ready" : "error",
      );
    } catch {
      return renderMainView(state, null, "error");
    }
  },
});
