/**
 * @file src/utils.ts
 * @description Shared utility functions used across capability handlers.
 *
 * @module stocks-interface/utils
 */

// ---------------------------------------------------------------------------
// Exported types
// ---------------------------------------------------------------------------

/**
 * The result returned by every capability handler in this tool.
 *
 * Both `text` and `html` representations are always populated on success so
 * Chalie can choose the best rendering surface. `error` is set only when the
 * handler could not complete the request.
 */
export interface CapabilityResult {
  /** Plain-text summary suitable for Chalie's reasoning context. */
  text: string;
  /**
   * Inline-CSS HTML card for rich rendering in the Chalie UI.
   * Never contains `<script>` tags.
   */
  html: string;
  /**
   * Human-readable error message when the handler failed.
   * Absent on success. `text` and `html` will contain user-facing error copy
   * even when this field is set.
   */
  error?: string;
}

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

/**
 * Escapes a string for safe interpolation into an HTML text node or attribute.
 *
 * @param str - Raw string to escape.
 * @returns HTML-safe string with `&`, `<`, `>`, `"`, and `'` replaced by
 *   their named HTML entity equivalents.
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
