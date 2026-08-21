/**
 * Sticky detail pane — the current row's FULL information, shown alongside
 * the list when the terminal is wide enough (Task 9's `allocateWidths`
 * negotiation lives in App.tsx; the design is recorded verbatim in tui-kit's
 * `width-alloc.d.ts`).
 *
 * ELABORATION, not context: every field this pane shows already has a
 * truncated cousin somewhere in the list row (title, url, badges, cg join),
 * so this pane's degraded form under a narrow terminal is ABSENCE — App
 * drops the whole column rather than squeezing it into something half
 * legible. That's why this component never truncates *itself* below its
 * given `cols` — the caller (App) is the one deciding whether the pane
 * exists at all.
 *
 * Pure presentational: no hooks besides `useTheme`, no I/O, no state. Width
 * safety mirrors row-layout.ts's invariant — every LINE this component
 * renders is the output of exactly one final `fitToWidth(line, cols)` call,
 * so a wrapping bug here can't reproduce the frame-corruption class that
 * file's header documents (ink WRAPS an overflowing Text; overflow="hidden"
 * clips boxes, not the extra lines wrapping manufactures). Content is
 * line-clamped to at most `viewport` lines — this pane rides beside the list
 * column and must never grow the frame past the list's own height.
 */

import type { Tab } from "@george43g/shared-types";
import { clusterWidth, fitToWidth, truncateToWidth, useTheme } from "@george43g/tui-kit";
import { Box, Text } from "ink";
import type { Row } from "./rows.js";

export interface DetailPaneProps {
  row: Row | undefined;
  cols: number;
  viewport: number;
}

/** Grapheme clusters of `text` — never splits a surrogate pair or ZWJ sequence. */
function clusters(text: string): string[] {
  try {
    return Array.from(
      new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
      (s) => s.segment,
    );
  } catch {
    // Intl.Segmenter is unavailable in some minimal runtimes; falling back to
    // UTF-16 iteration still respects surrogate pairs (`for...of` on a string
    // does), just not ZWJ sequences — best-effort, same contract as
    // tui-kit's own visual-width module.
    return Array.from(text);
  }
}

/**
 * Hard-wrap `text` into at most `maxLines` lines of at most `cols` cells
 * each, breaking only on grapheme-cluster boundaries. When content remains
 * beyond the line budget, the final line is truncated with an ellipsis
 * (via `truncateToWidth`) over the REST of the original text from that
 * point — not just the fragment that happened to be mid-accumulation — so
 * the cut lands on the same content a single-line truncation would have
 * shown.
 */
function wrapLines(text: string, cols: number, maxLines: number): string[] {
  if (cols <= 0 || maxLines <= 0) return [];
  const raw: string[] = [];
  let cur = "";
  let curW = 0;
  for (const seg of clusters(text)) {
    const w = clusterWidth(seg);
    if (curW + w > cols && cur !== "") {
      raw.push(cur);
      cur = "";
      curW = 0;
    }
    cur += seg;
    curW += w;
  }
  if (cur !== "") raw.push(cur);
  if (raw.length <= maxLines) return raw;
  const head = raw.slice(0, maxLines - 1);
  const remainder = raw.slice(maxLines - 1).join("");
  return [...head, truncateToWidth(remainder, cols)];
}

/** Tiny local relative-time formatter — no dependency, minute/hour/day only. */
function relativeTime(epochMs: number, now: number = Date.now()): string {
  if (!Number.isFinite(epochMs)) return "unknown";
  const deltaMs = now - epochMs;
  const past = deltaMs >= 0;
  const abs = Math.abs(deltaMs);
  const sec = Math.floor(abs / 1000);
  if (sec < 5) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 1) return past ? `${sec}s ago` : `in ${sec}s`;
  const hr = Math.floor(min / 60);
  if (hr < 1) return past ? `${min}m ago` : `in ${min}m`;
  const day = Math.floor(hr / 24);
  if (day < 1) return past ? `${hr}h ago` : `in ${hr}h`;
  return past ? `${day}d ago` : `in ${day}d`;
}

/** Spelled-out state badges, in the same left-to-right priority as `tabBadges`. */
function tabStateBadges(tab: Tab): string[] {
  const out: string[] = [];
  if (tab.audible) out.push("audio");
  if (tab.muted) out.push("muted");
  if (tab.pinned) out.push("pinned");
  if (tab.discarded) out.push("discarded");
  if (tab.frozen) out.push("frozen");
  return out;
}

/** Unwrapped content lines for `row` — width-unbounded; the caller fits each. */
function buildLines(row: Row, cols: number): string[] {
  if (row.kind === "tab") {
    const { tab, window, browser } = row;
    const lines: string[] = [
      ...wrapLines(tab.title || "(untitled)", cols, 2),
      ...wrapLines(tab.url, cols, 2),
    ];
    const badges = tabStateBadges(tab);
    lines.push(`state: ${badges.length > 0 ? badges.join(", ") : "none"}`);
    if (tab.groupId) {
      const group = browser.tabGroups.find((g) => g.groupId === tab.groupId);
      lines.push(`group: ${group?.title?.trim() || "(untitled)"} (${group?.color ?? "unknown"})`);
    }
    lines.push(
      `last accessed: ${tab.lastAccessed !== undefined ? relativeTime(tab.lastAccessed) : "unknown"}`,
    );
    lines.push(`window: ${window.title || "(untitled)"}`);
    lines.push(`browser: ${browser.browser}`);
    return lines;
  }

  if (row.kind === "window") {
    const { window, browser } = row;
    const activeTab = window.tabs.find((t) => t.active) ?? window.tabs[window.activeTabIndex];
    return [
      `window: ${window.title || "(untitled)"}`,
      window.bounds
        ? `bounds: ${window.bounds.x},${window.bounds.y} ${window.bounds.w}×${window.bounds.h}`
        : "bounds: unknown",
      window.cgWindowId !== null ? `cg: ${window.cgWindowId}` : "no cg join",
      `state: ${window.state ?? "unknown"}`,
      `tabs: ${window.tabCount}`,
      `active tab: ${activeTab ? activeTab.title || "(untitled)" : "none"}`,
      `browser: ${browser.browser}`,
    ];
  }

  const { browser } = row;
  const windows = browser.windows.length;
  const tabs = browser.windows.reduce((n, w) => n + w.tabCount, 0);
  const lines: string[] = [
    `browser: ${browser.browser}`,
    `source: ${browser.dataSource}`,
    `windows: ${windows}, tabs: ${tabs}`,
  ];
  if (browser.capabilities) {
    const entries = Object.values(browser.capabilities);
    const on = entries.filter(Boolean).length;
    lines.push(`capabilities: ${on}/${entries.length}`);
  }
  if (browser.error) lines.push(`error: ${browser.error}`);
  return lines;
}

export function DetailPane({ row, cols, viewport }: DetailPaneProps) {
  const theme = useTheme();
  const raw = row ? buildLines(row, cols) : ["no selection"];
  // Line-clamped to the shared viewport — this pane must never grow the
  // frame past the list column's own height. Every line's own width
  // guarantee comes from the SAME final `fitToWidth` call the row-layout.ts
  // invariant relies on, not from anything upstream getting the budget
  // arithmetic exactly right.
  const clamped = raw.slice(0, Math.max(0, viewport)).map((line) => fitToWidth(line, cols));
  return (
    <Box flexDirection="column">
      {clamped.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: lines are a stable, order-only render of derived text — position is the only identity there is.
        <Text key={i} wrap="truncate" color={theme.palette.fg} dimColor={i > 1}>
          {line}
        </Text>
      ))}
    </Box>
  );
}
