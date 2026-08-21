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
  allocateWidths,
  DevStatsPanel,
  HelpBar,
  type NavIntent,
  type NavState,
  navReduce,
  StatusBar,
  scrollbarThumb,
  truncateToWidth,
  useTerminalSize,
  useTheme,
  useVimKeys,
  viewportRows,
  visibleWindow,
} from "@george43g/tui-kit";
import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import { callMcpTool } from "../dispatcher.js";
import { APP_NAME, buildStamp } from "../meta.js";
import { engineLabel } from "../native-bridge.js";
import { availableActions, type TabActionChoice, visibleHints } from "./actions.js";
import { DetailPane } from "./DetailPane.js";
import { layoutRowText } from "./row-layout.js";
import { buildRows, type Row } from "./rows.js";
import { useSnapshot } from "./useSnapshot.js";

type Mode =
  | { kind: "browse" }
  | { kind: "confirm-close"; tabId: string; title: string }
  | { kind: "move"; tabId: string; title: string }
  | { kind: "action"; tabId: string; title: string; choices: TabActionChoice[] };

// Fixed footprint reserved for the `d` dev-stats panel — see the `d` handler
// below, which has carried this "~38 columns" figure since before the
// list/detail negotiation existed. R-T3: the panel must come OFF THE TOP of
// the budget the list/detail negotiation runs over, not compete inside it —
// a bare default-flexShrink Box sharing that negotiation lost every squeeze
// to the list/detail floors and collapsed to zero width (dogfood: it also
// displaced the help-bar row, since the panel's own text then wrapped across
// as many rows as it had characters).
const STATS_W = 38;

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
  // Declared ahead of the list/detail negotiation below — R-T3 needs its
  // value BEFORE allocateWidths runs, since the stats panel's reservation
  // has to come off the budget the negotiation itself sees, not compete
  // inside it.
  const [showStats, setShowStats] = useState(false);
  // Horizontal negotiation between the list and the sticky detail pane — the
  // design (and the "elaboration drops, context breadcrumbs" rule it comes
  // from) is recorded verbatim in tui-kit's width-alloc.d.ts. The list is
  // "min": it can shrink but never disappears, since it IS the thing being
  // browsed. The detail pane is "drop": every field it shows already has a
  // truncated cousin in the list row, so under a narrow terminal its
  // degraded form is ABSENCE, not a squeezed, half-legible copy. Real
  // allocateWidths sheds purely on `min` floors (44+28=72), so the pane
  // drops once `usableCols` (== termColumns-2) falls below 72 — i.e.
  // terminal columns below 74, not the 72 you'd get by forgetting the outer
  // paddingX={1}.
  //
  // R-T3: when the dev-stats panel is up it is a FIXED off-budget
  // reservation, not a third thing the negotiation shrinks — `negotiableCols`
  // is `usableCols` with `STATS_W` already taken off the top, so list/detail
  // never see (and can never lose a squeeze over) the columns the stats
  // panel owns. The panel's own Box gets the matching fixed width +
  // `flexShrink={0}` below, so the two reservations can't overlap.
  //
  // `statsShown` gates the reservation on the LIST's own 44-col floor, not
  // on the generic `usableCols`-style `Math.max(20, …)` floor above — that
  // floor exists to keep `allocateWidths` fed a sane minimum at
  // near-unusable widths, but reusing it here would let `negotiableCols`
  // sit ABOVE the true remainder (`usableCols - STATS_W`) once that
  // remainder drops under 20, and `listW` is only ever clamped to
  // `negotiableCols` — so the fixed `STATS_W` reservation plus that
  // inflated `listW` silently exceeded `usableCols` (measured: real column
  // overflow at 40x12 and 46x15). Below the list's floor the panel drops,
  // the same way the detail pane already drops below ITS floor, rather than
  // force a width-budget violation to keep it on screen.
  const statsShown = showStats && usableCols - STATS_W >= 44;
  const negotiableCols = statsShown ? usableCols - STATS_W : usableCols;
  const alloc = allocateWidths(negotiableCols, [
    {
      id: "list",
      min: 44,
      preferred: Math.ceil(negotiableCols * 0.65),
      priority: 1,
      collapse: "min",
    },
    {
      id: "detail",
      min: 28,
      preferred: Math.floor(negotiableCols * 0.35),
      priority: 0,
      collapse: "drop",
    },
  ]);
  // "min" columns are pinned at their floor even when the floor itself
  // exceeds the budget — allocateWidths' own contract (width-alloc.js:
  // "every remaining column is pinned, and the caller's renderer clips").
  // Below terminal ~46 cols (negotiableCols < list's 44-floor, with detail
  // already shed) that returns a list width LARGER than negotiableCols — and
  // this app's rows are `fitToWidth`-exact, not shrink-to-fit, so an
  // unclamped width doesn't degrade gracefully, it overflows the terminal
  // (measured: 45 printed cells on a 40-column screen). We are that
  // caller, so we clip here rather than trust the allocator's floor.
  const listW = Math.min(alloc.widths.list ?? negotiableCols, negotiableCols);
  const detailW = alloc.widths.detail ?? 0; // absent = dropped
  const [folded, setFolded] = useState<ReadonlySet<string>>(new Set());
  const [mode, setMode] = useState<Mode>({ kind: "browse" });
  const [message, setMessage] = useState("");

  const rows = useMemo(() => buildRows(snapshot, folded), [snapshot, folded]);

  const [nav, setNav] = useState<NavState>({ cursor: 0, count: null, touched: false });
  const navCtx = { itemCount: rows.length, pageSize: Math.floor(viewport / 2) };
  const dispatchNav = (intent: NavIntent) => setNav((s) => navReduce(s, intent, navCtx));

  // The cursor follows its ROW, by key, across a snapshot change — not the
  // numeric index, which would otherwise land on whatever row happens to
  // shift into the old slot (a window opening ABOVE the cursor used to jump
  // the highlight to an unrelated row).
  //
  // Guards on row CONTENT (key sequence), not `rows` array identity, before
  // dispatching. `rows` is a fresh array every render in this app's own test
  // fixtures (the mocked `useSnapshot` rebuilds the whole snapshot on every
  // call, so `useMemo`'s `[snapshot, folded]` deps never hit a cache) — and
  // `itemsReplaced` always returns a new state object, so an unguarded
  // dispatch on every render becomes an infinite render loop the instant
  // `rows`'s reference churns without its content changing. In real usage
  // `useSnapshot`'s `snapshot` state is stable across renders that don't
  // touch it, so this only ever fires on a genuine shape change there too —
  // the guard is a no-op in production and a correctness fix under test.
  const prevRowsRef = useRef(rows);
  useEffect(() => {
    const prev = prevRowsRef.current;
    if (prev === rows) return;
    const shapeChanged = prev.length !== rows.length || prev.some((r, i) => r.key !== rows[i]?.key);
    prevRowsRef.current = rows;
    if (!shapeChanged) return;
    setNav((s) =>
      navReduce(
        s,
        {
          kind: "itemsReplaced",
          remap: (old) => {
            const key = prev[old]?.key;
            const idx = key ? rows.findIndex((r) => r.key === key) : -1;
            return idx >= 0 ? idx : Math.min(old, Math.max(0, rows.length - 1));
          },
        },
        { itemCount: rows.length, pageSize: Math.floor(viewport / 2) },
      ),
    );
  }, [rows, viewport]);

  const current: Row | undefined = rows[nav.cursor];

  // Only windows of the SAME browser are legal move targets — a cross-browser
  // move is impossible, and offering one produced a confusing failure. The
  // tab's own window is excluded too: it was the default target, so pressing
  // m,Enter performed a no-op self-move.
  //
  // The source tab is the CURSOR's tab in browse mode and the MODE's tab once
  // move mode is entered. Both are needed: the `m` handler consults this list
  // BEFORE calling setMode, so an early-return of [] outside move mode made
  // the "no other window" guard refuse unconditionally — `m` was unreachable
  // from the day the guard shipped (#45) until a live key-by-key drive hit it.
  const moveTargets = useMemo(() => {
    const source =
      mode.kind === "move"
        ? rows.find((r) => r.kind === "tab" && r.tab.tabId === mode.tabId)
        : current;
    if (source?.kind !== "tab") return [];
    return rows.filter(
      (r) =>
        r.kind === "window" &&
        r.browser.browser === source.browser.browser &&
        r.window.windowId !== source.window.windowId,
    );
  }, [mode, rows, current]);
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

  const halfPage = (dir: 1 | -1) => {
    if (mode.kind !== "browse") return; // modal lists are shorter than a page; ^d/^u steer nothing there
    setMessage("");
    dispatchNav({ kind: dir === 1 ? "pageDown" : "pageUp" });
  };

  useVimKeys({
    onMove: (delta) => {
      if (mode.kind === "action") {
        setActionIdx((i) => Math.max(0, Math.min(mode.choices.length - 1, i + delta)));
      } else if (mode.kind === "move") {
        setTargetIdx((i) => Math.max(0, Math.min(moveTargets.length - 1, i + delta)));
      } else {
        // Any browse-mode motion retires the last action's message. It used to
        // persist for the rest of the session, permanently replacing the
        // row-count/liveness indicator with a stale success string.
        //
        // useVimKeys already resolves the vim count prefix (`5j` → a single
        // `onMove(5)` call) before this fires, so the delta here is already
        // the final repeat-multiplied step — this dispatches an absolute `set`
        // rather than feeding a `down`/`up` intent, so navReduce's OWN count
        // machinery (the `digit` intent, `state.count`) is never touched and
        // the two count models can't double-apply a repeat.
        //
        // The target index is computed from `s.cursor` INSIDE the setState
        // updater, not from the outer `nav.cursor` closure: useVimKeys fans a
        // single stdin chunk out across multiple synchronous `onMove` calls
        // (a fast "jj" burst or a paste), all before React re-renders. Reading
        // the closure would compute the same stale target for every call in
        // the burst and collapse them into one net move.
        setMessage("");
        setNav((s) => navReduce(s, { kind: "set", index: s.cursor + delta }, navCtx));
      }
    },
    onTop: () => {
      if (mode.kind !== "browse") return; // same guard as halfPage: gg has nothing to do in a modal list
      setMessage("");
      dispatchNav({ kind: "top" });
    },
    onBottom: () => {
      if (mode.kind !== "browse") return; // same guard as halfPage: G has nothing to do in a modal list
      setMessage("");
      dispatchNav({ kind: "bottom" });
    },
    // Mirrors onMove's browse branch: modal lists (move/action) are steered by
    // their own idx state, not the hidden browse cursor, and are short enough
    // that a half-page jump has nothing to do there. floor(): an odd viewport
    // would otherwise land the cursor on a .5 index, and rows[22.5] is
    // undefined.
    onHalfPageDown: () => halfPage(1),
    onHalfPageUp: () => halfPage(-1),
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
      setMessage("");
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
      : nav.cursor;
  const { start: visibleStart, end: visibleEnd } = visibleWindow(focusRow, rows.length, viewport);
  const visible = rows.slice(visibleStart, visibleEnd);

  // Scroll position indicator: a 1-column track at the right edge of the
  // list, shown ONLY when there's something to scroll (`thumbRows === 0`
  // means "everything fits" — no track at all, rows keep full width, no
  // reserved dead column). `trackRows` is the VIEWPORT, not `visible.length`:
  // when the list overflows, `visibleWindow` already sizes the shown slice to
  // exactly `viewport` rows, so a 0-based index into `visible` maps 1:1 onto
  // a row of the track. When the list fits, thumbRows is 0 and no row ever
  // consults the mapping.
  const thumb = scrollbarThumb(
    { start: visibleStart, end: visibleEnd, total: rows.length },
    viewport,
  );
  const showBar = thumb.thumbRows > 0;
  // rowCols now derives from the LIST column's allocated width, not the full
  // usable width — the scrollbar (and every row it decorates) lives entirely
  // inside `listW` once the detail pane claims the rest.
  const rowCols = showBar ? listW - 2 : listW;

  const renderRow = (row: Row, idx: number, barChar: string) => {
    const isCursor = idx === nav.cursor;
    const highlightTarget =
      mode.kind === "move" && row.kind === "window" && moveTargets[targetIdx]?.key === row.key;
    // Row text is composed and width-guaranteed entirely by layoutRowText —
    // this closure keeps only the color/highlight decision, not the layout.
    let text = layoutRowText(row, {
      cols: rowCols,
      moveTarget: highlightTarget,
      folded: row.kind === "window" ? folded.has(row.window.windowId) : undefined,
    });
    // Belt-and-braces: layoutRowText already guarantees visualWidth(text) ===
    // rowCols, so this is redundant today. Kept for one release in case a
    // future edit composes a row outside that guarantee.
    text = truncateToWidth(text, rowCols);
    // Composed OUTSIDE the row's own color wrapper — same principle as the
    // cursor highlight above: the bar is track chrome, not row content, so it
    // never inherits the row's background/foreground color. `null` when the
    // bar is hidden keeps the line at exactly `rowCols` (== `listW`, which is
    // usableCols only once the detail pane — and now the stats panel — have
    // both been shed) cells, matching the no-bar width budget.
    const bar = showBar ? (
      <>
        <Text> </Text>
        <Text color={barChar === "█" ? theme.palette.accent : theme.palette.fgDim}>{barChar}</Text>
      </>
    ) : null;
    if (isCursor || highlightTarget) {
      return (
        <Box key={row.key}>
          <Text wrap="truncate" color={theme.palette.bg} backgroundColor={theme.palette.accent}>
            {text}
          </Text>
          {bar}
        </Box>
      );
    }
    return (
      <Box key={row.key}>
        <Text
          // Belt-and-braces with the truncation above: even if a future edit
          // composes a row past the budget, Ink clips instead of wrapping.
          wrap="truncate"
          color={row.kind === "tab" ? theme.palette.fg : theme.palette.accent}
          dimColor={row.kind === "tab" && !row.tab.active}
        >
          {text}
        </Text>
        {bar}
      </Box>
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
        <Box flexDirection="column" width={listW} flexShrink={0} overflow="hidden">
          {visible.length === 0 ? (
            <Text color={theme.palette.fgDim}>
              {snapshot ? "No browser windows detected." : "Scanning browsers…"}
            </Text>
          ) : (
            visible.map((row, i) =>
              renderRow(
                row,
                visibleStart + i,
                // Guarded behind showBar: renderRow ignores barChar entirely
                // when the bar is hidden, so there's nothing to compute.
                !showBar
                  ? ""
                  : i >= thumb.thumbStart && i < thumb.thumbStart + thumb.thumbRows
                    ? "█"
                    : "│",
              ),
            )
          )}
        </Box>
        {/* Sticky detail pane (Task 9) — ELABORATION, so it DROPS rather than
            squeezes below the width floor; `detailW` is absent (0) exactly
            when allocateWidths shed it. 2 of its allocated columns are
            reserved for the "┃ " separator+gap so the printed row never
            exceeds `listW + detailW` (== usableCols, the allocator's own
            budget) — the pane's own content therefore renders at exactly
            `detailW - 2` columns. */}
        {detailW > 0 ? (
          <Box flexDirection="row" width={detailW} flexShrink={0} overflow="hidden">
            <Text dimColor>{"┃ "}</Text>
            <DetailPane row={current} cols={detailW - 2} viewport={viewport} />
          </Box>
        ) : null}
        {/* R-T3: joins the width negotiation as a fixed off-budget
            reservation (STATS_W, subtracted from negotiableCols above) —
            `flexShrink={0}` + an explicit `width` so it gets the SAME
            treatment as `listW`/`detailW` instead of the bare default
            (flexShrink 1, no width) that used to lose every squeeze to the
            list/detail floors and collapse to zero. `paddingLeft` (not
            `marginLeft`) keeps the old 2-column gap INSIDE the reserved
            width rather than adding to it — a margin sits outside a box's
            declared width, so it would silently blow the STATS_W budget by
            2 columns every time the panel is shown. Gated on `statsShown`,
            not `showStats` directly, so the panel and its reservation agree:
            below the list's floor it drops rather than render at a width
            nothing budgeted for. */}
        {statsShown ? (
          <Box width={STATS_W} flexShrink={0} paddingLeft={2} overflow="hidden">
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
