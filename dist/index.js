/**
 * @file src/index.ts
 * @description Main daemon entry point for the stocks-interface Chalie tool.
 *
 * Implements the Chalie tool IPC contract:
 *  1. Reads a base64-encoded JSON payload from `process.argv[2]`.
 *  2. Parses {@link ToolInput} (params, settings, telemetry).
 *  3. Loads persisted {@link ToolState} from disk via {@link loadState}.
 *  4. Resolves the Finnhub API key (`settings.apiKey` overrides `state.apiKey`).
 *  5. Shows the setup wizard HTML if no API key is available.
 *  6. Dispatches to the correct capability handler based on `params.capability`.
 *  7. Persists any mutated state returned by the handler.
 *  8. Writes a JSON result `{ text, html }` to stdout.
 *  9. Optionally starts the background {@link MarketSync} loop when the
 *     `STOCKS_DAEMON` environment variable equals `"1"`.
 * 10. Handles `SIGINT`/`SIGTERM` for graceful shutdown: stops the sync loop,
 *     flushes state to disk, then calls `process.exit(0)`.
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
import { FinnhubClient, FinnhubAuthError, FinnhubNetworkError, } from "./finnhub/client.js";
import { getDataDir, loadState, saveState } from "./state.js";
import { MarketSync } from "./sync/market-sync.js";
import { renderSetupPage } from "./ui/setup.js";
import { renderMainView } from "./ui/main.js";
import { handleStockQuote, handleStockCompare, handleStockHistory, handleStockNews, handleMarketStatus, handleEarningsCalendar, handleWatchlistAdd, handleWatchlistRemove, handleAlertSet, handleAlertList, handleAlertDelete, } from "./capabilities/index.js";
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
// Module-level daemon state (for graceful shutdown)
// ---------------------------------------------------------------------------
/**
 * Reference to the active sync-loop stop function when the daemon was started
 * with `STOCKS_DAEMON=1`.  `null` when the sync loop is not running.
 */
let stopSync = null;
/**
 * The most recently loaded (or mutated) tool state, captured so that
 * {@link flushAndExit} can flush it to disk without re-reading the file.
 */
let daemonState = null;
/**
 * The resolved data directory path, captured once in {@link main} so that
 * {@link flushAndExit} can call {@link saveState} without re-resolving it.
 */
let daemonDataDir = null;
// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------
/**
 * Serialises a {@link ToolOutput} value as a single-line JSON string and
 * writes it to `process.stdout`, followed by a newline character.
 *
 * This is the sole output channel back to the Chalie runtime; all other
 * diagnostic output goes to `process.stderr`.
 *
 * @param output - The tool result to serialise and emit.
 */
function writeOutput(output) {
    process.stdout.write(JSON.stringify(output) + "\n");
}
/**
 * Performs a graceful daemon shutdown:
 *  1. Calls the sync-loop {@link StopFn} (if running) to cancel pending timers.
 *  2. Flushes the current {@link ToolState} to disk via {@link saveState}.
 *  3. Calls `process.exit(code)`.
 *
 * Any error thrown by `saveState` is swallowed so the process always exits
 * cleanly rather than hanging on a filesystem error at shutdown time.
 *
 * @param code - Exit code forwarded to `process.exit`. Defaults to `0`.
 * @returns `Promise<never>` — this function never resolves normally.
 */
async function flushAndExit(code = 0) {
    if (stopSync !== null) {
        stopSync();
        stopSync = null;
    }
    if (daemonState !== null && daemonDataDir !== null) {
        try {
            await saveState(daemonDataDir, daemonState);
        }
        catch {
            // Best-effort flush — swallow errors to prevent recursive failure on
            // e.g. a read-only filesystem or disk-full condition at shutdown time.
        }
    }
    process.exit(code);
}
// ---------------------------------------------------------------------------
// Graceful-shutdown signal handlers
// ---------------------------------------------------------------------------
process.on("SIGINT", () => {
    void flushAndExit(0);
});
process.on("SIGTERM", () => {
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
async function main() {
    const dataDir = getDataDir();
    daemonDataDir = dataDir;
    // ── Step 1: Decode base64-encoded JSON IPC payload ───────────────────────
    const rawArg = process.argv[2] ?? "";
    let input;
    try {
        const decoded = Buffer.from(rawArg, "base64").toString("utf8");
        input = JSON.parse(decoded);
    }
    catch {
        writeOutput({
            text: "Invalid IPC payload: expected base64-encoded JSON in process.argv[2].",
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
            text: "Finnhub API key required. " +
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
    if (process.env["STOCKS_DAEMON"] === "1") {
        const sync = new MarketSync();
        stopSync = sync.startSync(state, client, (signal) => {
            // Signals are logged to stderr in the current implementation.
            // A production integration would forward them to Chalie's signal
            // queue via a dedicated IPC channel (e.g. named pipe or WebSocket).
            console.error(`[${TOOL_NAME}] signal(${signal.type}) ${signal.symbol}` +
                ` energy=${signal.energy}: ${signal.content}`);
        }, (quotes) => {
            console.error(`[${TOOL_NAME}] market_summary: ${quotes.length} symbol(s) at close`);
        });
    }
    // ── Step 7: Dispatch to the appropriate capability handler ────────────────
    try {
        let result;
        let updatedState = null;
        switch (params.capability) {
            // ── Stock data ─────────────────────────────────────────────────────
            case "stock_quote": {
                result = await handleStockQuote(params, client, state);
                break;
            }
            case "stock_compare": {
                result = await handleStockCompare(params, client, state);
                break;
            }
            case "stock_history": {
                result = await handleStockHistory(params, client, state);
                break;
            }
            case "stock_news": {
                result = await handleStockNews(params, client, state);
                break;
            }
            // ── Market data ────────────────────────────────────────────────────
            case "market_status": {
                result = await handleMarketStatus({}, client, state);
                break;
            }
            case "earnings_calendar": {
                result = await handleEarningsCalendar(params, client, state);
                break;
            }
            // ── Watchlist management ───────────────────────────────────────────
            case "watchlist_add": {
                const wAdd = await handleWatchlistAdd(params, client, state);
                result = wAdd.result;
                updatedState = wAdd.updatedState;
                break;
            }
            case "watchlist_remove": {
                const wRemove = handleWatchlistRemove(params, state);
                result = wRemove.result;
                updatedState = wRemove.updatedState;
                break;
            }
            // ── Price-alert management ─────────────────────────────────────────
            case "alert_set": {
                const aSet = handleAlertSet(params, state);
                result = aSet.result;
                updatedState = aSet.updatedState;
                break;
            }
            case "alert_list": {
                result = handleAlertList({}, state);
                break;
            }
            case "alert_delete": {
                const aDel = handleAlertDelete(params, state);
                result = aDel.result;
                updatedState = aDel.updatedState;
                break;
            }
            // ── Unknown capability — render the main dashboard as a fallback ────
            default: {
                const quotes = null;
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
        }
        else if (stateApiKeyChanged) {
            // Read-only capability — no updatedState returned — but the key changed.
            await saveState(dataDir, state);
        }
        // ── Step 9: Write JSON result to stdout ────────────────────────────────
        writeOutput({ text: result.text, html: result.html, error: result.error });
    }
    catch (err) {
        // ── Step 10: Error handling ────────────────────────────────────────────
        //
        // Classify API errors into user-facing setup-page variants so the user
        // can take corrective action (fix their key, check their network, etc.).
        if (err instanceof FinnhubAuthError) {
            writeOutput({
                text: err.message,
                html: renderSetupPage({ type: "auth", message: err.message }),
            });
        }
        else if (err instanceof FinnhubNetworkError) {
            writeOutput({
                text: err.message,
                html: renderSetupPage({ type: "network", message: err.message }),
            });
        }
        else {
            const message = err instanceof Error ? err.message : String(err);
            writeOutput({
                text: `An unexpected error occurred: ${message}`,
                html: `<div style="padding:16px;color:#d32f2f;font-family:` +
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
//# sourceMappingURL=index.js.map