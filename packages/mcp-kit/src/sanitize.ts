/**
 * Sanitize untrusted user text before emitting via MCP or terminal.
 *
 * Lifted from imsg-mcp/src/sanitize.ts.
 *
 * - Strips ANSI CSI and OSC escape sequences to prevent terminal corruption.
 * - Replaces NUL bytes and C0 control characters (except \n, \t, \r) with
 *   U+FFFD (Replacement Character) — keeps text scannable while making the
 *   substitution visible.
 * - Truncates the string if it exceeds `maxLength` (default 4096),
 *   appending a horizontal ellipsis.
 *
 * Call this on every user-content surface in tool responses: chat
 * snippets, search results, anything originally typed by a human or
 * sourced from a system you don't control.
 */

const ANSI_REGEX = new RegExp(
  [
    "[\\u001B\\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]+)*|[a-zA-Z\\d]+(?:;[-a-zA-Z\\d\\/#&.:=?%@~_]*)*)?\\u0007)",
    "(?:(?:\\d{1,4}(?:;\\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))",
  ].join("|"),
  "g",
);

// Matches C0 control characters, excluding \t (0x09), \n (0x0A), and \r (0x0D)
const CONTROL_CHAR_REGEX = /[\x00-\x08\x0B\x0C\x0E-\x1F]/g;

export function sanitize(text: string | null | undefined, maxLength = 4096): string | null {
  if (text == null) return null;
  let sanitized = text.replace(ANSI_REGEX, "");
  sanitized = sanitized.replace(CONTROL_CHAR_REGEX, "�");
  if (sanitized.length > maxLength) {
    sanitized = `${sanitized.slice(0, maxLength - 1)}…`;
  }
  return sanitized;
}

/**
 * Like {@link sanitize} but for large content payloads (extracted article
 * text, page state): strips the same terminal-hostile escapes and C0 control
 * characters, but does NOT truncate to a small default — content is capped at
 * its byte budget upstream (BROWSER_TAB_EXTRACT_MAX_BYTES) and shouldn't be
 * clipped again here. Always returns a string (never null) so callers can feed
 * it straight into a content block.
 */
export function sanitizeContent(text: string | null | undefined, maxLength = 1_000_000): string {
  if (text == null) return "";
  let out = text.replace(ANSI_REGEX, "");
  out = out.replace(CONTROL_CHAR_REGEX, "�");
  if (out.length > maxLength) out = `${out.slice(0, maxLength)}\n…[truncated]`;
  return out;
}
