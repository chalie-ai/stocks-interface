/**
 * @file src/ui/index.ts
 * @description Public re-exports for the UI rendering modules.
 *
 * Includes the setup wizard, main market view, and watchlist management
 * UI components rendered via Chalie's terminal interface primitives.
 */

export { renderSetupPage, renderValidatingPage } from "./setup.ts";
export type { SetupError } from "./setup.ts";
export {
  DEFAULT_WATCHLIST,
  renderEmptyWatchlist,
  renderWatchlistSection,
} from "./watchlist.ts";
export type { WatchlistItem } from "./watchlist.ts";
export { renderMainView } from "./main.ts";
export type { ViewState } from "./main.ts";
