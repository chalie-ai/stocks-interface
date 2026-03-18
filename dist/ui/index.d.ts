/**
 * @file src/ui/index.ts
 * @description Public re-exports for the UI rendering modules.
 *
 * Includes the setup wizard, main market view, and watchlist management
 * UI components rendered via Chalie's terminal interface primitives.
 */
export { renderSetupPage, renderValidatingPage } from "./setup.js";
export type { SetupError } from "./setup.js";
export { DEFAULT_WATCHLIST, renderWatchlistSection, renderEmptyWatchlist, } from "./watchlist.js";
export type { WatchlistItem } from "./watchlist.js";
export { renderMainView } from "./main.js";
export type { ViewState } from "./main.js";
//# sourceMappingURL=index.d.ts.map