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
export type SetupError = {
    type: "auth";
    message: string;
} | {
    type: "network";
    message: string;
} | {
    type: "service";
    message: string;
};
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
export declare function renderSetupPage(error?: SetupError): string;
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
export declare function renderValidatingPage(): string;
//# sourceMappingURL=setup.d.ts.map