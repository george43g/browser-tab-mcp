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

import { DevStatsPanel, HelpBar, StatusBar, useTheme, useVimKeys } from "@george43g/tui-kit";
import { Box, Text, useApp, useInput } from "ink";
import { useMemo, useState } from "react";
import { callMcpTool } from "../dispatcher.js";
import { APP_NAME, APP_VERSION } from "../meta.js";
import { engineLabel } from "../native-bridge.js";
import { buildRows, type Row, tabBadges } from "./rows.js";
import { useSnapshot } from "./useSnapshot.js";

const VIEWPORT = 24;

type Mode =
  | { kind: "browse" }
  | { kind: "confirm-close"; tabId: string; title: string }
  | { kind: "move"; tabId: string; title: string };

export function App() {
  const theme = useTheme();
  const { exit } = useApp();
  const { snapshot, live, refresh } = useSnapshot();
  const [cursor, setCursor] = useState(0);
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [mode, setMode] = useState<Mode>({ kind: "browse" });
  const [showStats, setShowStats] = useState(false);
  const [message, setMessage] = useState("");

  const rows = useMemo(() => buildRows(snapshot, folded), [snapshot, folded]);
  const clampedCursor = Math.min(cursor, Math.max(0, rows.length - 1));
  const current: Row | undefined = rows[clampedCursor];

  const moveTargets = useMemo(
    () => (mode.kind === "move" ? rows.filter((r) => r.kind === "window") : []),
    [mode.kind, rows],
  );
  const [targetIdx, setTargetIdx] = useState(0);

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
      if (mode.kind === "move") {
        setTargetIdx((i) => Math.max(0, Math.min(moveTargets.length - 1, i + delta)));
      } else {
        setCursor((c) => Math.max(0, Math.min(rows.length - 1, c + delta)));
      }
    },
    onTop: () => setCursor(0),
    onBottom: () => setCursor(Math.max(0, rows.length - 1)),
    onHalfPageDown: () => setCursor((c) => Math.min(rows.length - 1, c + VIEWPORT / 2)),
    onHalfPageUp: () => setCursor((c) => Math.max(0, c - VIEWPORT / 2)),
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

    if (input === "q" || key.escape) exit();
    if (input === "d") setShowStats((v) => !v);
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
    if (input === "m" && current?.kind === "tab") {
      setTargetIdx(0);
      setMode({ kind: "move", tabId: current.tab.tabId, title: current.tab.title });
    }
  });

  const visibleStart = Math.max(0, clampedCursor - Math.floor(VIEWPORT / 2));
  const visible = rows.slice(visibleStart, visibleStart + VIEWPORT);

  const renderRow = (row: Row, idx: number) => {
    const isCursor = idx === clampedCursor;
    let text: string;
    if (row.kind === "browser") {
      const tabs = row.browser.windows.reduce((a, w) => a + w.tabCount, 0);
      const src = row.browser.extensionConnected ? "extension" : "applescript";
      text = `▸ ${row.browser.browser} — ${row.browser.windows.length} windows, ${tabs} tabs [${src}]${row.browser.error ? " ⚠" : ""}`;
    } else if (row.kind === "window") {
      const fold = folded.has(row.window.windowId) ? "▸" : "▾";
      const cg = row.window.cgWindowId !== null ? ` cg=${row.window.cgWindowId}` : "";
      const isTarget =
        mode.kind === "move" && moveTargets[targetIdx]?.key === row.key ? " ◀ move here" : "";
      text = `  ${fold} ${row.window.title.slice(0, 60) || "(untitled)"} — ${row.window.tabCount} tabs${cg}${isTarget}`;
    } else {
      const marker = row.tab.active ? "●" : "·";
      const badges = tabBadges(row.tab, row.browser.tabGroups);
      const suffix = badges ? `  ${badges}` : "";
      text = `      ${marker} ${row.tab.title.slice(0, 50) || "(untitled)"}  ${row.tab.url.slice(0, 60)}${suffix}`;
    }
    const highlightTarget =
      mode.kind === "move" && row.kind === "window" && moveTargets[targetIdx]?.key === row.key;
    if (isCursor || highlightTarget) {
      return (
        <Text key={row.key} color={theme.palette.bg} backgroundColor={theme.palette.accent}>
          {text}
        </Text>
      );
    }
    return (
      <Text
        key={row.key}
        color={row.kind === "tab" ? theme.palette.fg : theme.palette.accent}
        dimColor={row.kind === "tab" && !row.tab.active}
      >
        {text}
      </Text>
    );
  };

  const statusMessage =
    mode.kind === "confirm-close"
      ? `close "${mode.title.slice(0, 50)}"? press y to confirm`
      : mode.kind === "move"
        ? `moving "${mode.title.slice(0, 40)}" — j/k picks window, Enter confirms, Esc cancels`
        : message || `${rows.length} rows · ${live ? "live (daemon)" : "polling"}`;

  return (
    <Box flexDirection="column" height="100%">
      <Box paddingX={1}>
        <Text color={theme.palette.accent} bold>
          {APP_NAME.replace(/^@[^/]+\//, "").replace(/-mcp$/, "")}
        </Text>
        <Text color={theme.palette.fgDim}>
          {" "}
          v{APP_VERSION} · {live ? "daemon stream" : "osascript polling"}
        </Text>
      </Box>

      <Box flexDirection="row" flexGrow={1} paddingX={1}>
        <Box flexDirection="column" flexGrow={1}>
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

      <StatusBar
        mode={mode.kind === "browse" ? "browse" : mode.kind}
        message={statusMessage}
        hint={`engine: ${engineLabel()}`}
      />
      <HelpBar
        hints={[
          { key: "j/k", label: "move" },
          { key: "⏎", label: "focus" },
          { key: "x", label: "close" },
          { key: "m", label: "move tab" },
          { key: "space", label: "fold" },
          { key: "r", label: "refresh" },
          { key: "q", label: "quit" },
        ]}
      />
    </Box>
  );
}
