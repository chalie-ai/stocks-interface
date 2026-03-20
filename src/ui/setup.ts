/**
 * Setup wizard UI for the Stocks Interface daemon (block protocol).
 *
 * Returns a block array for the Finnhub API key entry screen.
 * Form submission is handled via the `_setup_save_key` execute capability.
 *
 * @module stocks-interface/ui/setup
 */

import type { Block } from "../../../_sdk/blocks.ts";
import {
  section, header, text, form, input, actions, button,
  divider, alert, loading,
} from "../../../_sdk/blocks.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Discriminated union of error conditions during API key validation.
 *
 * | Variant     | HTTP cause        | Persistence                          |
 * |-------------|-------------------|--------------------------------------|
 * | `"auth"`    | 401 Unauthorized  | Key discarded                        |
 * | `"network"` | Fetch failure     | Nothing saved                        |
 * | `"service"` | 5xx / timeout     | Key saved optimistically, re-checked |
 */
export type SetupError =
  | { type: "auth"; message: string }
  | { type: "network"; message: string }
  | { type: "service"; message: string };

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/** Map error variant to user-facing alert block. */
function errorAlert(error: SetupError): Block {
  const map: Record<SetupError["type"], { msg: string; variant: "error" | "warning" }> = {
    auth: {
      msg: "This API key doesn't seem to work. Please double-check you copied the full key.",
      variant: "error",
    },
    network: {
      msg: "Couldn't connect to Finnhub. Please check your internet connection and try again.",
      variant: "error",
    },
    service: {
      msg: "Finnhub seems to be having issues right now. Your key has been saved — we'll verify it automatically when the service is back.",
      variant: "warning",
    },
  };
  const { msg, variant } = map[error.type];
  return alert(msg, variant);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Render the setup wizard as blocks.
 *
 * @param error - Optional error to display above the key field.
 * @returns Block array for the setup wizard UI.
 */
export function renderSetupPage(error?: SetupError): Block[] {
  const blocks: Block[] = [
    section([
      header("Connect to Finnhub", 2),
      text("Real-time market data for your watchlist", "plain"),
    ]),

    divider(),
  ];

  if (error) {
    blocks.push(errorAlert(error));
  }

  blocks.push(
    text(
      "Paste your Finnhub API key to enable live stock quotes, alerts, and market summaries. " +
      "The free tier supports up to 60 requests per minute — more than enough for a 30-symbol watchlist.",
      "plain",
    ),

    divider(),

    form("api-key-form", [
      input("api_key", { placeholder: "Finnhub API Key (e.g. pk_...)", type: "password" }),
      actions(
        button("Connect", { execute: "_setup_save_key", collect: "api-key-form" }),
      ),
    ]),

    divider(),

    text(
      "Don't have a key yet? Get your free API key at [finnhub.io](https://finnhub.io/dashboard)",
      "markdown",
    ),

  );

  return blocks;
}

/**
 * Render the validating state as blocks.
 *
 * Shown while the API key is being verified against Finnhub.
 *
 * @returns Block array for the validating state.
 */
export function renderValidatingPage(): Block[] {
  return [
    section([
      header("Validating API Key", 2),
      text(
        "Checking your key with Finnhub by fetching a live quote. " +
        "This usually takes under two seconds.",
        "plain",
      ),
      loading("Connecting to api.finnhub.io..."),
    ]),
  ];
}
