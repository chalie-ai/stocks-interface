/**
 * @file src/index.ts
 * @description Main daemon entry point for the stocks-interface Chalie tool.
 *
 * Implements the Chalie tool IPC contract:
 *  1. Reads a base64-encoded JSON payload from `Deno.args[0]`.
 *  2. Parses {@link ToolInput} (params, settings, telemetry).
 *  3. Loads persisted {@link ToolState} from disk via {@link loadState}.
 *  4. Resolves the Finnhub API key (`settings.apiKey` overrides `state.apiKey`).
 *  5. Shows the setup wizard HTML if no API key is available.
 *  6. Dispatches to the correct capability handler based on `params.capability`.
 *  7. Persists any mutated state returned by the handler.
 *  8. Writes a JSON result `{ text, html }` to stdout via `console.log`.
 *  9. Optionally starts the background {@link MarketSync} loop when the
 *     `STOCKS_DAEMON` environment variable equals `"1"`.
 * 10. Handles `SIGINT`/`SIGTERM` for graceful shutdown: stops the sync loop,
 *     flushes state to disk, then calls `Deno.exit(0)`.
 *
 * ## Capability dispatch table
 * | `params.capability`   | Handler                   | Mutates state |
 * |-----------------------|---------------------------|---------------|
 * | `stock_quote`         | {@link handleStockQuote}  | No            |
 * | `stock_compare`       | {@link handleStockCompare}| No            |
 * | `stock_history`       | {@link handleStockHistory}| No            |
 * | `stock_news`          | {@link handleStockNews}   | No            |
 * | `market_status`       | {@link handleMarketStatus}| No            |
 * | `earnings_calendar`   | {@link handleEarningsCalendar} | No       |
 * | `watchlist_add`       | {@link handleWatchlistAdd}| Yes           |
 * | `watchlist_remove`    | {@link handleWatchlistRemove} | Yes       |
 * | `alert_set`           | {@link handleAlertSet}    | Yes           |
 * | `alert_list`          | {@link handleAlertList}   | No            |
 * | `alert_delete`        | {@link handleAlertDelete} | Yes           |
 * | _(unknown)_           | Main dashboard view       | No            |
 *
 * ## Error routing
 * | Thrown class               | Output HTML                                  |
 * |----------------------------|----------------------------------------------|
 * | {@link FinnhubAuthError}   | `renderSetupPage({ type: "auth", ... })`     |
 * | {@link FinnhubNetworkError}| `renderSetupPage({ type: "network", ... })`  |
 * | Other `Error`              | Inline `<div>` with the error message        |
 *
 * @module stocks-interface
 */

import {
  FinnhubClient,
  FinnhubAuthError,
  FinnhubNetworkError,
} from "./finnhub/client.ts";
import { getDataDir, loadState, saveState } from "./state.ts";
import { MarketSync } from "./sync/market-sync.ts";
import type { StopFn } from "./sync/market-sync.ts";
import { renderSetupPage } from "./ui/setup.ts";
import { renderMainView } from "./ui/main.ts";
import type { ToolState, WatchlistItem, Quote } from "./finnhub/types.ts";
import type {
  CapabilityResult,
  HistoryPeriod,
  AlertSetParams,
  AlertDeleteParams,
} from "./capabilities/index.ts";
import {
  handleStockQuote,
  handleStockCompare,
  handleStockHistory,
  handleStockNews,
  handleMarketStatus,
  handleEarningsCalendar,
  handleWatchlistAdd,
  handleWatchlistRemove,
  handleAlertSet,
  handleAlertList,
  handleAlertDelete,
} from "./capabilities/index.ts";

// ---------------------------------------------------------------------------
// Public constants (Chalie tool contract)
// ---------------------------------------------------------------------------

/**
 * Unique tool identifier string used by the Chalie runtime to route IPC
 * messages to this tool. Must match the `name` field in `manifest.json`.
 */
export const TOOL_NAME = "stocks-interface";

/**
 * Semantic version of this tool. Incremented on each release; exposed here
 * so the version can be included in rendered UI cards and diagnostic output.
 */
export const TOOL_VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// IPC payload types (Chalie tool contract)
// ---------------------------------------------------------------------------

/**
 * Chalie-provided settings for this tool instance.
 *
 * Forwarded as part of every IPC invocation. Settings values override
 * persisted state where they overlap — currently only `apiKey`.
 */
interface ToolSettings {
  /** Finnhub API key entered by the user in Chalie's tool-settings panel. */
  apiKey?: string;
}

/**
 * Telemetry context forwarded from the Chalie runtime.
 *
 * Included for tools that need locale- or location-aware formatting.
 * Currently unused by this tool but declared for forward-compatibility with
 * the Chalie IPC contract.
 */
interface ToolTelemetry {
  /** User latitude, if location access was granted. */
  lat?: number;
  /** User longitude, if location access was granted. */
  lon?: number;
  /** Resolved city name from reverse geocoding. */
  city?: string;
  /** Current local time as an ISO 8601 string. */
  time?: string;
  /** IETF BCP 47 locale tag (e.g. `"en-US"`). */
  locale?: string;
}

/**
 * Decoded IPC payload received from the Chalie runtime via `Deno.args[0]`
 * (a base64-encoded JSON string).
 *
 * `params.capability` names the handler to invoke; all other `params` keys
 * are capability-specific parameters that each handler reads from the object.
 */
interface ToolInput {
  /**
   * Capability selector plus handler-specific parameters.
   *
   * `capability` is the only guaranteed key; all other keys depend on the
   * capability being invoked (e.g. `symbol` for `stock_quote`, `symbols[]`
   * for `stock_compare`, etc.).
   */
  params: Record<string, unknown> & { capability: string };

  /** Tool configuration injected by the Chalie runtime. */
  settings: ToolSettings;

  /** Runtime telemetry forwarded from Chalie for locale/location context. */
  telemetry: ToolTelemetry;
}

/**
 * JSON shape written to stdout (via `console.log`) after each capability dispatch.
 *
 * `text` is consumed by the Chalie reasoning layer; `html` is rendered in the
 * tool panel. `error` is set only on failure and may be absent on success.
 */
interface ToolOutput {
  /** Plain-text summary suitable for Chalie's reasoning context. */
  text: string;
  /** Inline-CSS HTML fragment for rich rendering in the Chalie tool panel. */
  html: string;
  /**
   * Human-readable error message when the capability failed.
   * Absent on successful completion.
   */
  error?: string;
}

// ---------------------------------------------------------------------------
// Module-level daemon state (for graceful shutdown)
// ---------------------------------------------------------------------------

/**
 * Reference to the active sync-loop stop function when the daemon was started
 * with `STOCKS_DAEMON=1`.  `null` when the sync loop is not running.
 */
let stopSync: StopFn | null = null;

/**
 * The most recently loaded (or mutated) tool state, captured so that
 * {@link flushAndExit} can flush it to disk without re-reading the file.
 */
let daemonState: ToolState | null = null;

/**
 * The resolved data directory path, captured once in {@link main} so that
 * {@link flushAndExit} can call {@link saveState} without re-resolving it.
 */
let daemonDataDir: string | null = null;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Serialises a {@link ToolOutput} value as a single-line JSON string and
 * writes it to stdout via `console.log`, which appends a newline character,
 * preserving the single-line-per-message IPC contract with the Chalie runtime.
 *
 * This is the sole output channel back to the Chalie runtime; all other
 * diagnostic output goes to stderr via `console.error`.
 *
 * @param output - The tool result to serialise and emit.
 */
function writeOutput(output: ToolOutput): void {
  console.log(JSON.stringify(output));
}

/**
 * Performs a graceful daemon shutdown:
 *  1. Calls the sync-loop {@link StopFn} (if running) to cancel pending timers.
 *  2. Flushes the current {@link ToolState} to disk via {@link saveState}.
 *  3. Calls `Deno.exit(code)`.
 *
 * Any error thrown by `saveState` is swallowed so the process always exits
 * cleanly rather than hanging on a filesystem error at shutdown time.
 *
 * @param code - Exit code forwarded to `Deno.exit`. Defaults to `0`.
 * @returns `Promise<void>` — `Deno.exit` terminates the process; the promise
 *   never resolves under normal circumstances.
 */
async function flushAndExit(code = 0): Promise<void> {
  if (stopSync !== null) {
    stopSync();
    stopSync = null;
  }

  if (daemonState !== null && daemonDataDir !== null) {
    try {
      await saveState(daemonDataDir, daemonState);
    } catch {
      // Best-effort flush — swallow errors to prevent recursive failure on
      // e.g. a read-only filesystem or disk-full condition at shutdown time.
    }
  }

  Deno.exit(code);
}

// ---------------------------------------------------------------------------
// Graceful-shutdown signal handlers
// ---------------------------------------------------------------------------

Deno.addSignalListener("SIGINT", (): void => {
  void flushAndExit(0);
});

Deno.addSignalListener("SIGTERM", (): void => {
  void flushAndExit(0);
});

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Main async entry point: decodes the IPC payload, loads state, resolves the
 * API key, dispatches to the correct capability handler, persists any mutated
 * state, and writes the JSON result to stdout.
 *
 * Invoked once per tool call in standard mode, or runs persistently with the
 * background {@link MarketSync} loop active when `STOCKS_DAEMON=1`.
 *
 * All top-level errors are caught and converted to user-facing output; the
 * process never exits with an unhandled promise rejection.
 *
 * @returns A `Promise<void>` that resolves after the result has been written
 *          (or rejects only in the presence of a logic bug — never on
 *          expected runtime errors such as API failures).
 */
async function main(): Promise<void> {
  const dataDir = getDataDir();
  daemonDataDir = dataDir;

  // ── Step 1: Decode base64-encoded JSON IPC payload ───────────────────────
  const rawArg = Deno.args[0] ?? "";
  let input: ToolInput;
  try {
    const decoded = atob(rawArg);
    input = JSON.parse(decoded) as ToolInput;
  } catch {
    writeOutput({
      text: "Invalid IPC payload: expected base64-encoded JSON in Deno.args[0].",
      html: renderSetupPage(),
      error: "Failed to decode or parse the base64 IPC payload.",
    });
    return;
  }

  const { params, settings } = input;

  // ── Step 2: Load persisted tool state ────────────────────────────────────
  const state = await loadState(dataDir);
  daemonState = state;

  // ── Step 3: Resolve API key ───────────────────────────────────────────────
  //
  // Settings (injected by the Chalie runtime from the tool-config panel) take
  // precedence. Persisted state is the fallback for daemon-mode invocations
  // where Chalie may not forward settings on every call.
  const settingsKey = (settings.apiKey ?? "").trim();
  const resolvedApiKey = settingsKey || state.apiKey.trim();

  // ── Step 4: Show setup wizard if no API key is available ─────────────────
  if (!resolvedApiKey) {
    writeOutput({
      text:
        "Finnhub API key required. " +
        "Please configure your key to enable live market data.",
      html: renderSetupPage(),
    });
    return;
  }

  // Propagate a new or changed settings key into persisted state so subsequent
  // daemon-mode invocations (without settings forwarded) still have the key.
  let stateApiKeyChanged = false;
  if (settingsKey && settingsKey !== state.apiKey) {
    state.apiKey = settingsKey;
    stateApiKeyChanged = true;
  }

  // ── Step 5: Instantiate the Finnhub API client ───────────────────────────
  const client = new FinnhubClient(resolvedApiKey);

  // ── Step 6: Start background sync loop (daemon mode only) ────────────────
  //
  // Only started when STOCKS_DAEMON=1 is set in the environment, indicating
  // the process is a long-lived daemon rather than a single-shot invocation.
  // In single-shot mode the process exits immediately after writing the result.
  if (Deno.env.get("STOCKS_DAEMON") === "1") {
    const sync = new MarketSync();
    stopSync = sync.startSync(
      state,
      client,
      (signal) => {
        // Signals are logged to stderr in the current implementation.
        // A production integration would forward them to Chalie's signal
        // queue via a dedicated IPC channel (e.g. named pipe or WebSocket).
        console.error(
          `[${TOOL_NAME}] signal(${signal.type}) ${signal.symbol}` +
            ` energy=${signal.energy}: ${signal.content}`,
        );
      },
      (quotes) => {
        console.error(
          `[${TOOL_NAME}] market_summary: ${quotes.length} symbol(s) at close`,
        );
      },
      async () => {
        // Persist state mutations accumulated during the sync cycle (e.g.
        // dedup history pruning, lastSyncAt updates, lastKnownMarketState)
        // so that state survives a daemon restart between cycles.
        await saveState(daemonDataDir!, daemonState!);
      },
    );
  }

  // ── Step 7: Dispatch to the appropriate capability handler ────────────────
  try {
    let result: CapabilityResult;
    let updatedState: ToolState | null = null;

    switch (params.capability) {
      // ── Stock data ─────────────────────────────────────────────────────

      case "stock_quote": {
        result = await handleStockQuote(
          params as unknown as { symbol: string },
          client,
          state,
        );
        break;
      }

      case "stock_compare": {
        result = await handleStockCompare(
          params as unknown as { symbols: string[] },
          client,
          state,
        );
        break;
      }

      case "stock_history": {
        result = await handleStockHistory(
          params as unknown as { symbol: string; period: HistoryPeriod },
          client,
          state,
        );
        break;
      }

      case "stock_news": {
        result = await handleStockNews(
          params as unknown as { symbol: string; limit?: number },
          client,
          state,
        );
        break;
      }

      // ── Market data ────────────────────────────────────────────────────

      case "market_status": {
        result = await handleMarketStatus(
          {} as Record<string, never>,
          client,
          state,
        );
        break;
      }

      case "earnings_calendar": {
        result = await handleEarningsCalendar(
          params as unknown as { symbol?: string; daysAhead?: number },
          client,
          state,
        );
        break;
      }

      // ── Watchlist management ───────────────────────────────────────────

      case "watchlist_add": {
        const wAdd = await handleWatchlistAdd(
          params as unknown as { symbol: string; type?: WatchlistItem["type"] },
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

      // ── Price-alert management ─────────────────────────────────────────

      case "alert_set": {
        const aSet = handleAlertSet(
          params as unknown as AlertSetParams,
          state,
        );
        result = aSet.result;
        updatedState = aSet.updatedState;
        break;
      }

      case "alert_list": {
        result = handleAlertList({} as Record<string, never>, state);
        break;
      }

      case "alert_delete": {
        const aDel = handleAlertDelete(
          params as unknown as AlertDeleteParams,
          state,
        );
        result = aDel.result;
        updatedState = aDel.updatedState;
        break;
      }

      // ── Unknown capability — render the main dashboard as a fallback ────

      default: {
        const quotes: Map<string, Quote> | null = null;
        const viewState = state.watchlist.length === 0 ? "empty" : "loading";
        result = {
          text: `${TOOL_NAME} v${TOOL_VERSION} — specify a capability to fetch data.`,
          html: renderMainView(state, quotes, viewState),
        };
        break;
      }
    }

    // ── Step 8: Persist mutated state ──────────────────────────────────────
    //
    // Capability handlers that mutate state return a new `updatedState` object.
    // When the settings API key changed, propagate it into `updatedState` so
    // the key is not silently dropped when the handler built a fresh copy of
    // state from the old (pre-key-update) snapshot.
    if (updatedState !== null) {
      if (stateApiKeyChanged) {
        updatedState = { ...updatedState, apiKey: settingsKey };
      }
      daemonState = updatedState;
      await saveState(dataDir, updatedState);
    } else if (stateApiKeyChanged) {
      // Read-only capability — no updatedState returned — but the key changed.
      await saveState(dataDir, state);
    }

    // ── Step 9: Write JSON result to stdout ────────────────────────────────
    writeOutput({ text: result.text, html: result.html, error: result.error });
  } catch (err) {
    // ── Step 10: Error handling ────────────────────────────────────────────
    //
    // Classify API errors into user-facing setup-page variants so the user
    // can take corrective action (fix their key, check their network, etc.).
    if (err instanceof FinnhubAuthError) {
      writeOutput({
        text: err.message,
        html: renderSetupPage({ type: "auth", message: err.message }),
      });
    } else if (err instanceof FinnhubNetworkError) {
      writeOutput({
        text: err.message,
        html: renderSetupPage({ type: "network", message: err.message }),
      });
    } else {
      const message = err instanceof Error ? err.message : String(err);
      writeOutput({
        text: `An unexpected error occurred: ${message}`,
        html:
          `<div style="padding:16px;color:#d32f2f;font-family:` +
          `-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">` +
          `An unexpected error occurred: ${message}</div>`,
        error: message,
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

void main();
