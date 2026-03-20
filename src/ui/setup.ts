/**
 * @file src/ui/setup.ts
 * @description Setup wizard HTML renderer for the stocks-interface tool.
 *
 * Generates HTML fragments for the Finnhub API key entry screen and the
 * interim validating state. All output conforms to the Chalie tool HTML
 * contract (09-TOOLS.md):
 *  - Inline CSS only — no `<style>` blocks, no external stylesheets.
 *  - No JavaScript — no `<script>` tags, no event handlers, no `javascript:` URIs.
 *  - Fragment only — no `<html>`, `<head>`, or `<body>` tags.
 *  - No dangerous tags — no `<form>`, `<input>`, `<iframe>`, `<object>`,
 *    `<embed>`, or `<base>`.
 *
 * Interaction (API key entry) is handled through Chalie's conversation
 * interface, not through native HTML form submission. The rendered HTML is a
 * visual guide card only.
 *
 * @module stocks-interface/ui/setup
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Discriminated union of the three error conditions that can occur when
 * validating a Finnhub API key during setup.
 *
 * | Variant     | HTTP cause        | Persistence         |
 * |-------------|-------------------|---------------------|
 * | `"auth"`    | 401 Unauthorized  | Key discarded       |
 * | `"network"` | Fetch failure     | Nothing saved       |
 * | `"service"` | 5xx / timeout     | Key saved optimistically, re-validated on next start |
 *
 * The `message` field carries the raw error detail for logging; it is NOT
 * shown to the user — user-facing copy is baked into {@link renderSetupPage}.
 */
export type SetupError =
  | { type: "auth"; message: string }
  | { type: "network"; message: string }
  | { type: "service"; message: string };

// ---------------------------------------------------------------------------
// Private constants
// ---------------------------------------------------------------------------

/** Primary accent colour for the setup card (financial teal). */
const ACCENT = "#00897b";

/** Semi-transparent tint used as the card background. */
const CARD_BG = "rgba(0, 137, 123, 0.08)";

/**
 * Border colour for the card container.
 * 33 = ~20 % opacity in hex.
 */
const CARD_BORDER = `${ACCENT}33`;

/** Error severity colour (soft red) used for `auth` and `network` banners. */
const ERROR_COLOR = "#d32f2f";

/** Warning severity colour (amber) used for the `service` banner. */
const WARNING_COLOR = "#f57c00";

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

/**
 * Maps a {@link SetupError} variant to its user-facing display text and
 * banner accent colour.
 *
 * Text is fixed per variant — the `error.message` field is for diagnostic
 * logging and is intentionally omitted from the UI to avoid exposing raw API
 * error strings to end users.
 *
 * @param error - The error whose display properties are needed.
 * @returns `{ text, color }` where `text` is the sentence shown in the banner
 *   and `color` is a CSS colour string.
 */
function resolveErrorDisplay(
  error: SetupError,
): { text: string; color: string } {
  switch (error.type) {
    case "auth":
      return {
        text:
          "This API key doesn't seem to work. Please double-check you copied the full key.",
        color: ERROR_COLOR,
      };
    case "network":
      return {
        text:
          "Couldn't connect to Finnhub. Please check your internet connection and try again.",
        color: ERROR_COLOR,
      };
    case "service":
      return {
        text:
          "Finnhub seems to be having issues right now. Your key has been saved — we'll verify it automatically when the service is back.",
        color: WARNING_COLOR,
      };
  }
}

/**
 * Renders an error banner HTML snippet for the given {@link SetupError}, or
 * returns an empty string when no error is present.
 *
 * The banner uses a left-coloured border and a tinted background to convey
 * severity at a glance without relying on external icons or assets.
 *
 * @param error - The error to render, or `undefined` for no output.
 * @returns A non-empty HTML string when `error` is defined; `""` otherwise.
 */
function renderErrorBanner(error: SetupError | undefined): string {
  if (!error) return "";

  const { text, color } = resolveErrorDisplay(error);

  return `<div style="
      margin-bottom: 16px;
      padding: 12px 14px;
      border-radius: 6px;
      border-left: 4px solid ${color};
      background: ${color}18;
      color: ${color};
      font-size: 0.875rem;
      line-height: 1.5;
    ">${text}</div>`;
}

/**
 * Chooses the CSS border colour for the pseudo-input field based on whether
 * an error is present and its severity.
 *
 * - No error → neutral grey (`#ccc`).
 * - `"service"` error → amber (warning-level).
 * - `"auth"` or `"network"` error → red (error-level).
 *
 * @param error - The current {@link SetupError}, or `undefined`.
 * @returns A CSS colour string suitable for use in `border: ... solid <value>`.
 */
function inputBorderColor(error: SetupError | undefined): string {
  if (!error) return "rgba(234,230,242,0.20)";
  return error.type === "service" ? WARNING_COLOR : ERROR_COLOR;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Renders the setup wizard HTML fragment for Finnhub API key entry.
 *
 * The fragment contains:
 * 1. A card header with an icon and title.
 * 2. An optional error banner when a {@link SetupError} is supplied.
 * 3. A brief description instructing the user to paste their key.
 * 4. A styled pseudo-input field (a read-only visual affordance — no
 *    `<input>` element) with a monospaced placeholder.
 * 5. A "Get your free API key at finnhub.io" help link.
 * 6. A styled submit affordance (non-interactive `<div>`, no `<button>`
 *    or `<form>` elements per the Chalie HTML contract).
 * 7. A helper tip reminding the user of the chat command syntax.
 *
 * @param error - Optional error to display above the key field. Omitting
 *   this parameter renders the page in its clean, no-error state.
 * @returns A non-empty HTML fragment string conforming to the Chalie tool
 *   HTML contract. Safe for use as the `html` field in tool output JSON.
 *
 * @example
 * // Clean state — no prior validation attempt
 * const html = renderSetupPage();
 *
 * @example
 * // After a 401 response from Finnhub
 * const html = renderSetupPage({ type: "auth", message: "401 Unauthorized" });
 *
 * @example
 * // After a network failure
 * const html = renderSetupPage({ type: "network", message: "fetch failed" });
 *
 * @example
 * // After a Finnhub 503
 * const html = renderSetupPage({ type: "service", message: "503 Service Unavailable" });
 */
export function renderSetupPage(error?: SetupError): string {
  const errorBanner = renderErrorBanner(error);
  const borderColor = inputBorderColor(error);

  return `<div style="
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    max-width: 480px;
  ">

    <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 20px;">
      <div style="
        width: 42px;
        height: 42px;
        border-radius: 10px;
        background: ${ACCENT};
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        font-size: 1.3rem;
      ">📈</div>
      <div>
        <div style="font-size: 1.05rem; font-weight: 700; color: #eae6f2; line-height: 1.25;">
          Connect to Finnhub
        </div>
        <div style="font-size: 0.78rem; color: rgba(234,230,242,0.55); margin-top: 2px;">
          Real-time market data for your watchlist
        </div>
      </div>
    </div>

    ${errorBanner}

    <div style="
      font-size: 0.875rem;
      color: rgba(234,230,242,0.75);
      line-height: 1.65;
      margin-bottom: 18px;
    ">
      Paste your Finnhub API key below to enable live stock quotes, alerts,
      and market summaries. The free tier supports up to 60 requests per minute —
      more than enough for a 30-symbol watchlist.
    </div>

    <div style="
      font-size: 0.75rem;
      font-weight: 600;
      color: rgba(234,230,242,0.85);
      text-transform: uppercase;
      letter-spacing: 0.06em;
      margin-bottom: 6px;
    ">Finnhub API Key</div>

    <div style="
      background: transparent;
      border: 1.5px solid ${borderColor};
      border-radius: 8px;
      padding: 10px 14px;
      font-size: 0.875rem;
      font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', 'Courier New', monospace;
      color: rgba(234,230,242,0.35);
      margin-bottom: 10px;
      min-height: 42px;
      display: flex;
      align-items: center;
      letter-spacing: 0.03em;
    ">
      <span>pk_••••••••••••••••••••••••••••••••</span>
    </div>

    <div style="font-size: 0.825rem; color: rgba(234,230,242,0.58); margin-bottom: 22px;">
      Don't have a key yet?
      <a
        href="https://finnhub.io/dashboard"
        style="color: ${ACCENT}; text-decoration: none; font-weight: 600;"
      >Get your free API key at finnhub.io →</a>
    </div>

    <div style="
      display: inline-block;
      background: ${ACCENT};
      color: #fff;
      font-size: 0.875rem;
      font-weight: 600;
      padding: 10px 22px;
      border-radius: 8px;
      letter-spacing: 0.01em;
    ">Connect</div>

    <div style="
      margin-top: 16px;
      padding: 10px 13px;
      background: rgba(255, 255, 255, 0.04);
      border-radius: 6px;
      font-size: 0.78rem;
      color: rgba(234,230,242,0.55);
      line-height: 1.55;
    ">
      💡 Type
      <span style="
        font-family: 'SF Mono', 'Fira Code', monospace;
        font-size: 0.8rem;
        background: rgba(255,255,255,0.07);
        padding: 1px 5px;
        border-radius: 4px;
        color: rgba(234,230,242,0.85);
      ">set api_key YOUR_KEY</span>
      in the chat to configure your key, then ask Chalie to
      &ldquo;show my watchlist&rdquo; to get started.
    </div>

  </div>`;
}

/**
 * Renders an interim HTML fragment displayed while the Finnhub API key is
 * being validated.
 *
 * Shown immediately after the user submits their key and before the
 * validation response is received. Communicates in-progress status via
 * CSS-only visual cues (a static progress bar fill and faded status dots) —
 * no JavaScript or animations are used.
 *
 * @returns A non-empty HTML fragment string conforming to the Chalie tool
 *   HTML contract. Safe for use as the `html` field in tool output JSON.
 *
 * @example
 * const html = renderValidatingPage();
 */
export function renderValidatingPage(): string {
  return `<div style="
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    max-width: 480px;
    text-align: center;
  ">

    <div style="font-size: 2.4rem; margin-bottom: 14px; line-height: 1;">🔑</div>

    <div style="
      font-size: 1.05rem;
      font-weight: 700;
      color: #eae6f2;
      margin-bottom: 8px;
    ">Validating API Key…</div>

    <div style="
      font-size: 0.875rem;
      color: rgba(234,230,242,0.58);
      line-height: 1.6;
      margin-bottom: 22px;
      max-width: 320px;
      margin-left: auto;
      margin-right: auto;
    ">
      Checking your key with Finnhub by fetching a live quote.
      This usually takes under two seconds.
    </div>

    <div style="
      height: 4px;
      background: rgba(255,255,255,0.10);
      border-radius: 2px;
      overflow: hidden;
      margin-bottom: 16px;
      max-width: 280px;
      margin-left: auto;
      margin-right: auto;
    ">
      <div style="
        height: 100%;
        width: 55%;
        background: ${ACCENT};
        border-radius: 2px;
        margin-left: 15%;
      "></div>
    </div>

    <div style="
      display: flex;
      justify-content: center;
      gap: 7px;
      margin-bottom: 18px;
    ">
      <div style="width: 8px; height: 8px; border-radius: 50%; background: ${ACCENT};"></div>
      <div style="width: 8px; height: 8px; border-radius: 50%; background: ${ACCENT}99;"></div>
      <div style="width: 8px; height: 8px; border-radius: 50%; background: ${ACCENT}44;"></div>
    </div>

    <div style="font-size: 0.78rem; color: rgba(234,230,242,0.38); letter-spacing: 0.02em;">
      Connecting to api.finnhub.io…
    </div>

  </div>`;
}
