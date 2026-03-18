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
import type { ToolState } from "./finnhub/types.js";
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
export declare const DEFAULT_STATE: ToolState;
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
export declare function getDataDir(): string;
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
export declare function loadState(dataDir: string): Promise<ToolState>;
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
export declare function saveState(dataDir: string, state: ToolState): Promise<void>;
//# sourceMappingURL=state.d.ts.map