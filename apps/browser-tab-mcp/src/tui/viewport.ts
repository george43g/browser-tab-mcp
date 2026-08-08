/**
 * Scroll-window arithmetic for the tab list (pure — unit testable without ink).
 *
 * Both halves of this used to be wrong:
 *  - the viewport was a hardcoded 24, so a 50-row terminal wasted 22 rows and a
 *    20-row terminal overflowed the flex container and overprinted the chrome;
 *  - the window start was never clamped to the end of the list, so the list
 *    visibly SHRANK as the cursor approached the bottom (34 rows / viewport 24
 *    rendered 13 at the end).
 */

/**
 * Rows the chrome occupies: 1 header + 1 StatusBar top border + 1 StatusBar
 * body + 1 HelpBar. HelpBar can wrap to a second line on a very narrow
 * terminal, so the list container is also `overflow="hidden"` — an
 * under-estimate must clip, never overflow.
 */
export const CHROME_ROWS = 4;

/** Always render at least one row, even in an absurdly short terminal. */
export const MIN_VIEWPORT = 1;

export function viewportRows(terminalRows: number): number {
  if (!Number.isFinite(terminalRows)) return MIN_VIEWPORT;
  return Math.max(MIN_VIEWPORT, Math.floor(terminalRows) - CHROME_ROWS);
}

export interface VisibleWindow {
  start: number;
  end: number;
}

/**
 * Centre `cursor` in a `viewport`-tall window over `total` rows, clamped to
 * both ends. The window is always exactly `min(viewport, total)` tall.
 */
export function visibleWindow(cursor: number, total: number, viewport: number): VisibleWindow {
  const size = Math.max(MIN_VIEWPORT, viewport);
  const maxStart = Math.max(0, total - size);
  const centred = cursor - Math.floor(size / 2);
  const start = Math.min(maxStart, Math.max(0, centred));
  return { start, end: Math.min(total, start + size) };
}
