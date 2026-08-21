/**
 * Row → single-line text, laid out with tui-kit's width primitives instead of
 * hand-rolled `String.slice` budgets.
 *
 * THE INVARIANT: `visualWidth(layoutRowText(row, opts)) === opts.cols`
 * EXACTLY, for every row kind, at every width, with any title content
 * (empty/huge/emoji/CJK/lone-surrogate). See row-layout.test.ts.
 *
 * How the invariant survives sloppy internal math: each branch below composes
 * a candidate string from a prefix/title/suffix that were sized against a
 * *budget* derived from `cols`, but that sizing only needs to get CLOSE. The
 * branch's return value is always the composed string passed through exactly
 * one final `fitToWidth(composed, cols)` call, and `fitToWidth`'s own
 * postcondition (truncate-then-pad, `visualWidth(result) === cols` always,
 * even for `cols <= 0` → `""`) is what actually guarantees the width — not
 * the internal budget arithmetic. That is why the window/tab branches can
 * floor a sub-budget at 8 or 10 cells even when `cols` is smaller than the
 * fixed chrome around it: the composed string may run over, and the final
 * `fitToWidth` clips it back to exactly `cols` regardless.
 *
 * That closing clip is a width guarantee, not a CONTENT priority — it drops
 * whatever is rightmost, blind to what that content means. The window
 * branch's move-target marker is the one piece this file protects
 * explicitly (see its comment): a priority-ordered suffix picks a shorter
 * candidate *before* the close-out clip ever has to reach for the marker.
 * Tab-row badge/URL loss at narrow widths is accepted as-is (ELABORATION,
 * not context) — deferred to the detail-pane task, not fixed here.
 */

import { allocateWidths, fitToWidth, visualWidth } from "@george43g/tui-kit";
import { type Row, tabBadges } from "./rows.js";

export interface LayoutRowOpts {
  cols: number;
  moveTarget: boolean;
  /** Window rows only — whether this window's tab list is collapsed. */
  folded?: boolean | undefined;
}

export function layoutRowText(row: Row, opts: LayoutRowOpts): string {
  const { cols } = opts;

  if (row.kind === "browser") {
    const tabs = row.browser.windows.reduce((a, w) => a + w.tabCount, 0);
    const src = row.browser.extensionConnected ? "extension" : "applescript";
    const text = `▸ ${row.browser.browser} — ${row.browser.windows.length} windows, ${tabs} tabs [${src}]${row.browser.error ? " ⚠" : ""}`;
    return fitToWidth(text, cols);
  }

  if (row.kind === "window") {
    // Compose prefix/suffix ONCE and derive the title budget from the real
    // strings — the old code kept a hand-copied `fixed` skeleton (a near-dupe
    // of the real template with the title stripped out) that could silently
    // drift from the line it was meant to be measuring.
    const fold = opts.folded ? "▸" : "▾";
    // A null cgWindowId is the wm-stack join failing — the thing this tool
    // exists to surface. Say so rather than rendering an absence.
    const cg = row.window.cgWindowId !== null ? ` cg=${row.window.cgWindowId}` : " cg:none";
    const tabsPart = ` — ${row.window.tabCount} tabs`;
    // The move-target marker is CONTEXT, not elaboration: losing it while
    // `moveTarget` is true recreates the exact incident shape this file
    // documents — steering a target that silently isn't the one shown, then
    // acting on it. So it is the LAST piece of the suffix sacrificed: cg
    // (least essential once the window is already identified by title) goes
    // first, then the tab count. Below that even the title's own floor
    // yields to it — see the fallback below — because a marker present but
    // wordless still tells the truth, while a title with no marker lies
    // about where Enter will land. Only once `prefix + marker` alone can't
    // fit (~16 cols, below any real geometry) does the closing `fitToWidth`
    // clip the marker text itself, same as it clips everything else.
    const markerPart = opts.moveTarget ? " ◀ move here" : "";
    const prefix = `  ${fold} `;
    const title = row.window.title || "(untitled)";
    const TITLE_FLOOR = 8;
    const prefixW = visualWidth(prefix);
    // Most complete to least: full suffix, drop cg, drop the tab count too
    // (leaving only the marker — or nothing, when there's no move target).
    const suffixCandidates = [
      `${tabsPart}${cg}${markerPart}`,
      `${tabsPart}${markerPart}`,
      markerPart,
    ];
    // Default: the most degraded candidate, giving the title whatever room
    // is left (even below TITLE_FLOOR) — the fallback for when nothing else
    // fits the floor, so the marker still gets first claim on what's left.
    let suffix = suffixCandidates[suffixCandidates.length - 1] as string;
    let titleW = Math.max(0, cols - prefixW - visualWidth(suffix));
    for (const candidate of suffixCandidates) {
      const remainder = cols - prefixW - visualWidth(candidate);
      if (remainder >= TITLE_FLOOR) {
        suffix = candidate;
        titleW = remainder;
        break;
      }
    }
    return fitToWidth(prefix + fitToWidth(title, titleW) + suffix, cols);
  }

  const marker = row.tab.active ? "●" : "·";
  const badges = tabBadges(row.tab, row.browser.tabGroups);
  const prefix = `      ${marker} `;
  const suffix = badges ? `  ${badges}` : "";
  // Title and URL compete for the remaining cells; the URL is elaboration and
  // DROPS when starved, the title is the minimum viable identity and always
  // stays (floored, never dropped).
  const budget = Math.max(10, cols - visualWidth(prefix) - visualWidth(suffix));
  const alloc = allocateWidths(budget, [
    {
      id: "title",
      min: 8,
      preferred: Math.min(50, Math.ceil(budget * 0.55)),
      priority: 1,
      collapse: "min",
    },
    { id: "url", min: 12, preferred: Math.min(60, budget), priority: 0, collapse: "drop" },
  ]);
  const titleW = alloc.widths.title ?? Math.max(8, budget);
  const urlW = alloc.widths.url ?? 0;
  const title = fitToWidth(row.tab.title || "(untitled)", titleW);
  const url = urlW > 0 ? `  ${fitToWidth(row.tab.url, Math.max(0, urlW - 2))}` : "";
  return fitToWidth(prefix + title + url + suffix, cols);
}
