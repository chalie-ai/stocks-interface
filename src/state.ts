/**
 * @file src/state.ts
 * @description Persistence layer for the stocks-interface tool's runtime state.
 *
 * Provides atomic read/write helpers for {@link ToolState} backed by a JSON
 * file in a configurable data directory. The atomic write pattern (write to a
 * `.tmp` file then `fs.rename`) prevents partial-write corruption on process
 * crash or power loss.
 *
 * Usage:
 * ```ts
 * import { loadState, saveState, getDataDir, DEFAULT_STATE } from "./state.js";
 *
 * const dir   = getDataDir();
 * const state = await loadState(dir);
 * state.lastSyncAt = new Date().toISOString();
 * await saveState(dir, state);
 * ```
 *
 * @module stocks-interface/state
 */

import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { ToolState } from "./finnhub/types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Name of the JSON file within the data directory that holds the persisted
 * {@link ToolState} blob.
 */
const STATE_FILENAME = "state.json";

/**
 * Suffix appended to {@link STATE_FILENAME} during an atomic write operation.
 * The file is written here first, then atomically renamed to the real path.
 */
const TMP_SUFFIX = ".tmp";

// ---------------------------------------------------------------------------
// Default state
// ---------------------------------------------------------------------------

/**
 * Safe baseline {@link ToolState} used when no persisted state file exists
 * (first run) or when the existing file cannot be parsed.
 *
 * Notable defaults:
 * - `watchlist` is intentionally empty — symbols are added during setup.
 * - `priceAlerts` / `dedupHistory` start empty.
 * - `lastKnownMarketState` is `null` until the first market-status poll.
 * - Settings embed Finnhub free-tier–friendly polling intervals and
 *   conservative notification thresholds.
 *
 * @constant
 */
export const DEFAULT_STATE: ToolState = {
  apiKey: "",
  watchlist: [],
  priceAlerts: [],
  lastSyncAt: null,
  lastMarketSummaryDate: null,
  lastKnownMarketState: null,
  dedupHistory: [],
  settings: {
    /** 2 minutes — stays comfortably within the 60 req/min free-tier ceiling. */
    syncIntervalMarketOpen: 120_000,
    /** 5 minutes — conserves quota overnight and on weekends. */
    syncIntervalMarketClosed: 300_000,
    /** 2% intraday move triggers a stock_move signal; 5% triggers stock_alert. */
    notableThresholdStock: 2.0,
    /** 1% for broad market indices/ETFs (SPY, QQQ, DIA). */
    notableThresholdIndex: 1.0,
    /** Hard ceiling enforced by watchlist add UI and capabilities. */
    maxWatchlistSize: 30,
  },
} as const;

// ---------------------------------------------------------------------------
// Data directory resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the path to the data directory used for persisting tool state.
 *
 * Resolution order:
 * 1. `STOCKS_DATA_DIR` environment variable (if set and non-empty).
 * 2. `~/.chalie/stocks-interface/` (platform home directory via `os.homedir()`).
 *
 * The returned path is **not** guaranteed to exist; callers that require the
 * directory to exist must create it with `fs.mkdir(..., { recursive: true })`.
 *
 * @returns Absolute path to the data directory.
 *
 * @example
 * ```ts
 * const dir = getDataDir();
 * // "/home/alice/.chalie/stocks-interface"  (default)
 * // "/tmp/stocks-test"                       (when STOCKS_DATA_DIR is set)
 * ```
 */
export function getDataDir(): string {
  const envValue = process.env["STOCKS_DATA_DIR"];
  if (envValue !== undefined && envValue.length > 0) {
    return envValue;
  }
  return path.join(os.homedir(), ".chalie", "stocks-interface");
}

// ---------------------------------------------------------------------------
// Load
// ---------------------------------------------------------------------------

/**
 * Reads the persisted {@link ToolState} from `<dataDir>/state.json`.
 *
 * Handles the following error conditions gracefully — returning
 * {@link DEFAULT_STATE} instead of throwing:
 * - File does not exist (`ENOENT`).
 * - File contents are not valid JSON.
 * - Parsed JSON is not an object (e.g. the file was truncated to `null`).
 *
 * The returned state is a **deep copy** of the parsed JSON merged with
 * `DEFAULT_STATE` so that any fields added in newer versions of the interface
 * are populated with their defaults rather than being `undefined`.
 *
 * @param dataDir - Absolute path to the data directory (obtain via {@link getDataDir}).
 * @returns The persisted tool state, or {@link DEFAULT_STATE} if unavailable.
 *
 * @example
 * ```ts
 * const state = await loadState(getDataDir());
 * console.log(state.apiKey); // "" on first run
 * ```
 */
export async function loadState(dataDir: string): Promise<ToolState> {
  const filePath = path.join(dataDir, STATE_FILENAME);

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (isNodeError(err) && err.code === "ENOENT") {
      // First run — state file does not yet exist.
      return structuredClone(DEFAULT_STATE);
    }
    // Unexpected I/O error (e.g. permissions). Log and fall back to defaults.
    console.error(
      `[stocks-interface] Failed to read state file at "${filePath}":`,
      err,
    );
    return structuredClone(DEFAULT_STATE);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Corrupt / truncated JSON — fall back to defaults.
    console.error(
      `[stocks-interface] state.json at "${filePath}" is not valid JSON; ` +
        "resetting to defaults.",
    );
    return structuredClone(DEFAULT_STATE);
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    console.error(
      `[stocks-interface] state.json at "${filePath}" contains an unexpected ` +
        "root type; resetting to defaults.",
    );
    return structuredClone(DEFAULT_STATE);
  }

  // Merge persisted data on top of DEFAULT_STATE so new fields introduced in
  // later versions always have a defined value.
  const defaults = structuredClone(DEFAULT_STATE);
  const persisted = parsed as Partial<ToolState>;

  return {
    ...defaults,
    ...persisted,
    // Deep-merge the settings sub-object so individual new setting keys also
    // receive defaults rather than being silently absent.
    settings: {
      ...defaults.settings,
      ...(persisted.settings ?? {}),
    },
  };
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

/**
 * Atomically persists the given {@link ToolState} to `<dataDir>/state.json`.
 *
 * The write strategy:
 * 1. Ensure `dataDir` exists (creates it recursively if absent).
 * 2. Serialise `state` to pretty-printed JSON.
 * 3. Write to a temporary file `<dataDir>/state.json.tmp`.
 * 4. Atomically rename the temp file to the real path.
 *
 * Step 4 is an atomic operation on POSIX filesystems, meaning a concurrent
 * reader will always see either the old complete file or the new complete file —
 * never a partially written state.
 *
 * @param dataDir - Absolute path to the data directory (obtain via {@link getDataDir}).
 * @param state   - The current tool state to persist.
 * @returns A promise that resolves when the file has been durably written.
 * @throws Re-throws any filesystem error that occurs after the directory has
 *         been created — callers should handle unexpected I/O failures.
 *
 * @example
 * ```ts
 * await saveState(getDataDir(), { ...currentState, lastSyncAt: new Date().toISOString() });
 * ```
 */
export async function saveState(
  dataDir: string,
  state: ToolState,
): Promise<void> {
  // 1. Ensure the directory exists.
  await fs.mkdir(dataDir, { recursive: true });

  const realPath = path.join(dataDir, STATE_FILENAME);
  const tmpPath = realPath + TMP_SUFFIX;

  // 2. Serialise — pretty-print for human readability during debugging.
  const json = JSON.stringify(state, null, 2);

  // 3. Write to tmp file.
  await fs.writeFile(tmpPath, json, "utf8");

  // 4. Atomic rename tmp → real.
  await fs.rename(tmpPath, realPath);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Type guard that narrows `unknown` to a Node.js `ErrnoException` so callers
 * can safely access `.code` without an unsafe cast.
 *
 * @param err - The value to test.
 * @returns `true` if `err` is a non-null object with a `code` string property.
 */
function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return (
    err !== null &&
    typeof err === "object" &&
    "code" in err &&
    typeof (err as Record<string, unknown>)["code"] === "string"
  );
}
