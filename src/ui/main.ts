/**
 * Main dashboard view for the Stocks Interface daemon (block protocol).
 *
 * Renders a different block layout depending on the {@link ViewState}:
 *  - `"loading"` — skeleton cards while the first sync cycle runs.
 *  - `"error"`   — a banner explaining the connectivity failure.
 *  - `"empty"`   — empty-watchlist prompt plus suggested prompts.
 *  - `"ready"`   — index summary, watchlist cards, and active alerts count.
 *
 * @module stocks-interface/ui/main
 */

import type { Block } from "../../../_sdk/blocks.ts";
import {
  section, text, columns, badge, alert, loading, divider,
} from "../../../_sdk/blocks.ts";
import type { Quote, ToolState } from "../finnhub/types.ts";
import { renderEmptyWatchlist, renderWatchlistSection } from "./watchlist.ts";

// ---------------------------------------------------------------------------
// Public type
// ---------------------------------------------------------------------------

export type ViewState = "loading" | "error" | "empty" | "ready";

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function formatPrice(value: number): string {
  return `$${value.toFixed(2)}`;
}

function formatChange(value: number): string {
  const sign = value >= 0 ? "+" : "\u2212";
  return `${sign}${Math.abs(value).toFixed(2)}%`;
}

function changeVariant(value: number): "success" | "error" | "info" {
  if (value > 0) return "success";
  if (value < 0) return "error";
  return "info";
}

// ---------------------------------------------------------------------------
// Private section renderers
// ---------------------------------------------------------------------------

/** Index summary row — compact columns for index-proxy ETFs. */
function renderIndexSummaryRow(
  state: ToolState,
  quotes: Map<string, Quote>,
): Block[] {
  const indexItems = state.watchlist.filter((item) => item.isIndex);
  if (indexItems.length === 0) return [];

  const cols = indexItems.map((item) => {
    const quote = quotes.get(item.symbol);
    const content: Block[] = [
      text(`**${item.symbol}**`, "markdown"),
      text(item.name, "plain"),
    ];
    if (quote) {
      content.push(
        text(`**${formatPrice(quote.price)}**`, "markdown"),
        badge(formatChange(quote.changePercent), changeVariant(quote.changePercent)),
      );
    } else {
      content.push(loading());
    }
    return { width: "1fr" as const, blocks: content };
  });

  return [section([columns(...cols)], "Market Overview")];
}

/** Active alerts count badge. */
function renderAlertsCountBadge(state: ToolState): Block[] {
  const activeCount = state.priceAlerts.filter((a) => a.active).length;
  if (activeCount === 0) return [];

  const label = activeCount === 1
    ? "1 active price alert"
    : `${activeCount} active price alerts`;

  return [
    alert(
      `${label} — ask Chalie "show my price alerts" to review them.`,
      "info",
    ),
  ];
}

/** Suggested prompts for the empty-watchlist state. */
const SUGGESTED_PROMPTS = [
  "How is the S&P 500 doing today?",
  "Add Tesla to my watchlist",
  "Set an alert if AAPL drops below $170",
];

function renderSuggestedPrompts(): Block[] {
  return [
    section(
      [
        text("Try asking:", "plain"),
        ...SUGGESTED_PROMPTS.map((p) => text(`\u2022 "${p}"`, "plain")),
      ],
      "Suggested Prompts",
      true,
    ),
  ];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render the main stock-market dashboard as blocks.
 *
 * @param state     - Current persisted tool state.
 * @param quotes    - Live quote data keyed by symbol, or `null` when loading.
 * @param viewState - The dashboard variant to render.
 * @returns Block array for the main dashboard UI.
 */
export function renderMainView(
  state: ToolState,
  quotes: Map<string, Quote> | null,
  viewState: ViewState,
): Block[] {
  switch (viewState) {
    case "loading":
      return [
        loading("Fetching market data..."),
        ...renderWatchlistSection(state.watchlist, null),
      ];

    case "error": {
      const lastUpdated = state.lastSyncAt
        ? new Date(state.lastSyncAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })
        : "never";
      const retryMinutes = Math.round(
        state.settings.syncIntervalMarketClosed / 60_000,
      );
      const retryLabel = retryMinutes === 1
        ? "1 minute"
        : `${retryMinutes} minutes`;
      return [
        alert("Unable to reach Finnhub", "error"),
        text(
          `Last updated: **${lastUpdated}**. Retrying in **${retryLabel}**.`,
          "markdown",
        ),
      ];
    }

    case "empty":
      return [...renderEmptyWatchlist(), ...renderSuggestedPrompts()];

    case "ready": {
      if (quotes === null) return renderMainView(state, null, "loading");

      const blocks: Block[] = [];

      // Last sync timestamp
      if (state.lastSyncAt) {
        const time = new Date(state.lastSyncAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        });
        blocks.push(text(`Updated ${time}`, "plain"));
      }

      // Index summary
      blocks.push(...renderIndexSummaryRow(state, quotes));

      // Non-index watchlist
      const nonIndexItems = state.watchlist.filter((item) => !item.isIndex);
      if (nonIndexItems.length > 0) {
        blocks.push(...renderWatchlistSection(nonIndexItems, quotes));
      }

      // Active alerts
      blocks.push(...renderAlertsCountBadge(state));

      return blocks;
    }
  }
}
