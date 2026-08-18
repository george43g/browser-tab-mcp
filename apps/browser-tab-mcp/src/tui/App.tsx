/**
 * browser-tab TUI — live tab manager.
 *
 * Tree: browser > window > tab, fed by the daemon event stream (falls
 * back to 5s polling when the daemon is down).
 *
 * Keys: j/k move · gg/G top/bottom · ^d/^u half-page · space/za fold window
 *       Enter focus tab · x close tab (press y to confirm) · m move mode
 *       (j/k picks the target window, Enter moves, Esc cancels)
 *       r refresh · d dev stats · q quit
 */

import {
  DevStatsPanel,
  HelpBar,
  StatusBar,
  truncateToWidth,
  useTerminalSize,
  useTheme,
  useVimKeys,
  viewportRows,
  visibleWindow,
  visualWidth,
} from "@george43g/tui-kit";
import { Box, Text, useApp, useInput } from "ink";
import { useMemo, useState } from "react";
import { callMcpTool } from "../dispatcher.js";
import { APP_NAME, buildStamp } from "../meta.js";
import { engineLabel } from "../native-bridge.js";
import { availableActions, type TabActionChoice, visibleHints } from "./actions.js";
import { buildRows, type Row, tabBadges } from "./rows.js";
import { useSnapshot } from "./useSnapshot.js";

type Mode =
  | { kind: "browse" }
  | { kind: "confirm-close"; tabId: string; title: string }
  | { kind: "move"; tabId: string; title: string }
  | { kind: "action"; tabId: string; title: string; choices: TabActionChoice[] };

export function App() {
  const theme = useTheme();
  const { exit } = useApp();
  const { snapshot, live, refresh } = useSnapshot();
  const { rows: termRows, columns: termColumns } = useTerminalSize();
  const viewport = viewportRows(termRows);
  // Every row must fit ONE line. Ink word-wraps a Text that overflows, and
  // `overflow="hidden"` does not clip the extra lines — so an over-long row
  // silently turns N rows into N+k printed lines, the frame scrolls, and the
  // chrome (status bar, help bar) is overprinted. That was reproducible below
  // ~156 columns with real data. Container has paddingX={1}.
  const usableCols = Math.max(20, (termColumns || 80) - 2);
  const [cursor, setCursor] = useState(0);
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [mode, setMode] = useState<Mode>({ kind: "browse" });
  const [showStats, setShowStats] = useState(false);
  const [message, setMessage] = useState("");

  const rows = useMemo(() => buildRows(snapshot, folded), [snapshot, folded]);
  const clampedCursor = Math.min(cursor, Math.max(0, rows.length - 1));
  const current: Row | undefined = rows[clampedCursor];

  // Only windows of the SAME browser are legal move targets — a cross-browser
  // move is impossible, and offering one produced a confusing failure. The
  // tab's own window is excluded too: it was the default target, so pressing
  // m,Enter performed a no-op self-move.
  const moveTargets = useMemo(() => {
    if (mode.kind !== "move") return [];
    const source = rows.find((r) => r.kind === "tab" && r.tab.tabId === mode.tabId);
    if (source?.kind !== "tab") return [];
    return rows.filter(
      (r) =>
        r.kind === "window" &&
        r.browser.browser === source.browser.browser &&
        r.window.windowId !== source.window.windowId,
    );
  }, [mode, rows]);
  const [targetIdx, setTargetIdx] = useState(0);
  const [actionIdx, setActionIdx] = useState(0);

  const runCommand = (tool: string, args: Record<string, unknown>, verb: string) => {
    void callMcpTool(tool, args).then((result) => {
      if (result.isError) {
        const first = result.content.find((b) => b.type === "text");
        const detail = first && first.type === "text" ? first.text : "?";
        setMessage(`${verb} failed: ${detail.slice(0, 120)}`);
      } else {
        setMessage(`${verb} ✓`);
        refresh();
      }
    });
  };

  useVimKeys({
    onMove: (delta) => {
      if (mode.kind === "action") {
        setActionIdx((i) => Math.max(0, Math.min(mode.choices.length - 1, i + delta)));
      } else if (mode.kind === "move") {
        setTargetIdx((i) => Math.max(0, Math.min(moveTargets.length - 1, i + delta)));
      } else {
        // Any motion retires the last action's message. It used to persist for
        // the rest of the session, permanently replacing the row-count/liveness
        // indicator with a stale success string.
        setMessage("");
        setCursor((c) => Math.max(0, Math.min(rows.length - 1, c + delta)));
      }
    },
    onTop: () => {
      setMessage("");
      setCursor(0);
    },
    onBottom: () => {
      setMessage("");
      setCursor(Math.max(0, rows.length - 1));
    },
    // floor(): an odd viewport would otherwise land the cursor on a .5 index,
    // and rows[22.5] is undefined.
    onHalfPageDown: () => setCursor((c) => Math.min(rows.length - 1, c + Math.floor(viewport / 2))),
    onHalfPageUp: () => setCursor((c) => Math.max(0, c - Math.floor(viewport / 2))),
    onUnhandled: () => {},
  });

  useInput((input, key) => {
    if (mode.kind === "confirm-close") {
      if (input === "y") {
        runCommand("close_tab", { tabId: mode.tabId }, `close "${mode.title.slice(0, 40)}"`);
      }
      setMode({ kind: "browse" });
      return;
    }
    if (mode.kind === "move") {
      if (key.escape) {
        setMode({ kind: "browse" });
        return;
      }
      if (key.return) {
        const target = moveTargets[targetIdx];
        if (target?.kind === "window") {
          runCommand(
            "move_tab",
            {
              tabId: mode.tabId,
              targetWindowId: target.window.windowId,
              allowReload: target.browser.browser === "safari",
            },
            "move",
          );
        }
        setMode({ kind: "browse" });
      }
      return;
    }

    if (mode.kind === "action") {
      if (key.escape) {
        setMode({ kind: "browse" });
        return;
      }
      if (key.return) {
        const choice = mode.choices[actionIdx];
        if (choice) {
          runCommand("tab_action", { tabId: mode.tabId, action: choice.action }, choice.label);
        }
        setMode({ kind: "browse" });
      }
      return;
    }

    if (input === "q" || key.escape) exit();
    // `!key.ctrl` matters: Ink reports ^D as input "d" with key.ctrl, and
    // useVimKeys has already consumed it as half-page-down. Without the guard,
    // scrolling down a half page also toggles the stats panel — which steals
    // ~38 columns from the list and used to trigger the wrapping bug above.
    if (input === "d" && !key.ctrl) setShowStats((v) => !v);
    if (input === "r") {
      refresh();
      setMessage("refreshed");
    }
    if ((input === " " || input === "z") && current) {
      const windowId =
        current.kind === "window"
          ? current.window.windowId
          : current.kind === "tab"
            ? current.window.windowId
            : null;
      if (windowId) {
        setFolded((prev) => {
          const next = new Set(prev);
          if (next.has(windowId)) next.delete(windowId);
          else next.add(windowId);
          return next;
        });
      }
    }
    if (key.return && current?.kind === "tab") {
      runCommand("focus_tab", { tabId: current.tab.tabId }, "focus");
    }
    if (input === "x" && current?.kind === "tab") {
      setMode({ kind: "confirm-close", tabId: current.tab.tabId, title: current.tab.title });
    }
    if (input === "a" && current?.kind === "tab") {
      // Same refusal as `m`: a picker with nothing in it would consume Enter
      // and leave the previous action's message on screen, so the user gets no
      // signal at all. Say why instead.
      const choices = availableActions(current.browser, current.tab);
      if (choices.length === 0) {
        setMessage(`no tab actions available for ${current.browser.browser}`);
        return;
      }
      setMessage("");
      setActionIdx(0);
      setMode({ kind: "action", tabId: current.tab.tabId, title: current.tab.title, choices });
      return;
    }
    if (input === "m" && current?.kind === "tab") {
      // Refusing beats entering a mode whose only action is a silent no-op:
      // with no legal target, Enter did nothing and the status bar still showed
      // the PREVIOUS action's message, so the user got no signal at all.
      if (moveTargets.length === 0) {
        setMessage("no other window in this browser to move to");
        return;
      }
      setMessage("");
      setTargetIdx(0);
      setMode({ kind: "move", tabId: current.tab.tabId, title: current.tab.title });
    }
  });

  // In move mode the thing the user is steering is the TARGET, not the cursor.
  // Centring on the cursor meant `j` produced a byte-identical frame whenever
  // the target was outside the scroll window — and Enter then moved the tab
  // into a window that was never shown.
  const focusRow =
    mode.kind === "move"
      ? Math.max(
          0,
          rows.findIndex((r) => r.key === moveTargets[targetIdx]?.key),
        )
      : clampedCursor;
  const { start: visibleStart, end: visibleEnd } = visibleWindow(focusRow, rows.length, viewport);
  const visible = rows.slice(visibleStart, visibleEnd);

  const renderRow = (row: Row, idx: number) => {
    const isCursor = idx === clampedCursor;
    let text: string;
    if (row.kind === "browser") {
      const tabs = row.browser.windows.reduce((a, w) => a + w.tabCount, 0);
      const src = row.browser.extensionConnected ? "extension" : "applescript";
      text = `▸ ${row.browser.browser} — ${row.browser.windows.length} windows, ${tabs} tabs [${src}]${row.browser.error ? " ⚠" : ""}`;
    } else if (row.kind === "window") {
      const fold = folded.has(row.window.windowId) ? "▸" : "▾";
      // A null cgWindowId is the wm-stack join failing — the thing this tool
      // exists to surface. Say so rather than rendering an absence.
      const cg = row.window.cgWindowId !== null ? ` cg=${row.window.cgWindowId}` : " cg:none";
      const isTarget =
        mode.kind === "move" && moveTargets[targetIdx]?.key === row.key ? " ◀ move here" : "";
      const fixed = `  ${fold}  — ${row.window.tabCount} tabs${cg}${isTarget}`;
      const titleW = Math.max(8, usableCols - visualWidth(fixed));
      text = `  ${fold} ${truncateToWidth(row.window.title || "(untitled)", titleW)} — ${row.window.tabCount} tabs${cg}${isTarget}`;
    } else {
      const marker = row.tab.active ? "●" : "·";
      const badges = tabBadges(row.tab, row.browser.tabGroups);
      const suffix = badges ? `  ${badges}` : "";
      // Split the remaining cells between title and url rather than chopping
      // either at a fixed length — at 100 cols the old fixed budgets alone
      // needed 122, so the row wrapped before a single badge was added.
      const budget = Math.max(10, usableCols - visualWidth(`      ${marker}   ${suffix}`));
      const titleW = Math.max(8, Math.min(50, Math.floor(budget * 0.55)));
      const urlW = Math.max(0, Math.min(60, budget - titleW));
      const title = truncateToWidth(row.tab.title || "(untitled)", titleW);
      const url = urlW > 0 ? `  ${truncateToWidth(row.tab.url, urlW)}` : "";
      text = `      ${marker} ${title}${url}${suffix}`;
    }
    // Single guarantee, whatever the branch composed above: one row, one line.
    text = truncateToWidth(text, usableCols);
    const highlightTarget =
      mode.kind === "move" && row.kind === "window" && moveTargets[targetIdx]?.key === row.key;
    if (isCursor || highlightTarget) {
      return (
        <Text
          key={row.key}
          wrap="truncate"
          color={theme.palette.bg}
          backgroundColor={theme.palette.accent}
        >
          {text}
        </Text>
      );
    }
    return (
      <Text
        key={row.key}
        // Belt-and-braces with the truncation above: even if a future edit
        // composes a row past the budget, Ink clips instead of wrapping.
        wrap="truncate"
        color={row.kind === "tab" ? theme.palette.fg : theme.palette.accent}
        dimColor={row.kind === "tab" && !row.tab.active}
      >
        {text}
      </Text>
    );
  };

  const statusMessage =
    mode.kind === "action"
      ? // Name the action AND the tab: the row can be scrolled off, and running
        // `discard` on the wrong tab is not obviously undoable.
        `${truncateToWidth(mode.title, 24)} → ${
          mode.choices[actionIdx]?.label ?? "(none)"
        } — j/k picks, Enter runs, Esc cancels`
      : mode.kind === "confirm-close"
        ? `close "${mode.title.slice(0, 50)}"? press y to confirm`
        : mode.kind === "move"
          ? // Name the target: the marker row can be scrolled off, and even when
            // it isn't, "which window am I about to move into" should not require
            // hunting for a highlight.
            `moving "${truncateToWidth(mode.title, 30)}" → "${truncateToWidth(
              moveTargets[targetIdx]?.kind === "window"
                ? (moveTargets[targetIdx] as Extract<Row, { kind: "window" }>).window.title ||
                    "(untitled)"
                : "(none)",
              30,
            )}" — j/k picks, Enter confirms, Esc cancels`
          : message || `${rows.length} rows · ${live ? "live (daemon)" : "polling"}`;

  return (
    <Box flexDirection="column" height="100%">
      {/* Pinned to one line. viewportRows() subtracts a CONSTANT chrome height,
          so any chrome that wraps at narrow widths silently steals a row from
          the list and pushes the frame past the screen — a width bug that
          presents as a height overflow. */}
      <Box paddingX={1} height={1} overflow="hidden">
        <Text color={theme.palette.accent} bold wrap="truncate">
          {APP_NAME.replace(/^@[^/]+\//, "").replace(/-mcp$/, "")}
        </Text>
        <Text color={theme.palette.fgDim} wrap="truncate">
          {" "}
          v{buildStamp()} · {live ? "daemon stream" : "osascript polling"}
        </Text>
      </Box>

      <Box flexDirection="row" flexGrow={1} paddingX={1} overflow="hidden">
        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          {visible.length === 0 ? (
            <Text color={theme.palette.fgDim}>
              {snapshot ? "No browser windows detected." : "Scanning browsers…"}
            </Text>
          ) : (
            visible.map((row, i) => renderRow(row, visibleStart + i))
          )}
        </Box>
        {showStats ? (
          <Box marginLeft={2}>
            <DevStatsPanel visible engine={engineLabel()} />
          </Box>
        ) : null}
      </Box>

      {/* Same reason as the help bar: a long message wraps the bordered box to
          a third line at ~40 columns. Two rows is its natural height and what
          CHROME_ROWS budgets for, so pin it there. */}
      <Box height={2} overflow="hidden" flexShrink={0}>
        <StatusBar
          mode={mode.kind === "browse" ? "browse" : mode.kind}
          message={statusMessage}
          hint={`engine: ${engineLabel()}`}
        />
      </Box>
      {/* HelpBar is flexWrap="wrap" in the kit, so below ~90 columns it needs a
          second line and chrome becomes 5 rows against a CHROME_ROWS of 4.
          Clamped here rather than upstream: a wrapping help bar is right for a
          consumer that sizes its own viewport, wrong for one that doesn't. */}
      <Box height={1} overflow="hidden">
        <HelpBar hints={visibleHints(termColumns)} />
      </Box>
    </Box>
  );
}
