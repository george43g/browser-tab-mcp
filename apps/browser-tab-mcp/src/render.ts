/**
 * Human-readable renderers for CLI results.
 *
 * WHY THIS LIVES HERE, not in mcp-kit: `dispatch.ts` builds its text block with
 * `JSON.stringify(result)` and that is the MCP protocol surface — a host parses
 * it. Rendering for humans therefore belongs on the CLI side of the boundary and
 * runs only when the resolved output mode is "human". `--json`, a piped stdout
 * and `CI=true` all keep the exact JSON that scripts already depend on.
 *
 * Every renderer is a pure `value -> string`, so they unit-test without a TTY.
 * Colour depends on the ambient environment (`NO_COLOR`, `FORCE_COLOR`, isatty),
 * so tests strip SGR rather than assuming it is off.
 *
 * TWO RULES every row here obeys, both learned the hard way:
 *
 *   1. Width is a promise. Rows go through `layoutRow`, which DROPS optional
 *      columns before squeezing the flexible one. The previous
 *      `Math.max(12, width - fixed)` was a floor, and a floor cannot prevent an
 *      overflow — it hands the title more room than the row has.
 *   2. The actionable field is load-bearing. A handle (`t:chrome:x11`,
 *      `w:chrome:x1`) and the `cg:` join key are never dropped, because a row
 *      you can read but cannot feed back into `focus`/`window set` has lost the
 *      only reason it was printed.
 */

import { color } from "@george43g/cli-kit";

const DEFAULT_WIDTH = 100;

/** Terminal width to lay out for, clamped to something sane for pipes/tests. */
export function layoutWidth(columns = process.stdout.columns): number {
  if (!Number.isFinite(columns) || (columns as number) <= 0) return DEFAULT_WIDTH;
  return Math.max(40, Math.min(200, Math.floor(columns as number)));
}

/** Truncate to `max` display columns, marking elision with a single ellipsis. */
export function truncate(s: string, max: number): string {
  const flat = String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (max <= 1) return flat.slice(0, Math.max(0, max));
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

const GAP = "  ";
/** Below this a title is unreadable, so drop a column instead of squeezing. */
const MIN_FLEX = 12;

/**
 * One column of a row. `text` is always PLAIN — width maths must never see
 * colour, because an SGR escape costs bytes and zero columns.
 */
interface Cell {
  text: string;
  /** Applied after the maths, so colour cannot push a row over the width. */
  paint?: (s: string) => string;
  /** Drop order when the row won't fit; higher goes first. Absent = never. */
  sacrifice?: number;
  /** The one cell that absorbs slack. At most one per row. */
  flex?: boolean;
  /** Separator before this cell. Defaults to `GAP`; `" "` keeps a marker tight. */
  gap?: string;
}

/**
 * Lay out one row inside `width`, dropping optional columns before squeezing
 * the flexible one.
 *
 * The old shape — `truncate(title, Math.max(12, width - fixed))` — used a FLOOR
 * where a clamp was needed. Once the fixed columns exceeded `width - 12` the
 * floor handed the title more room than the row actually had, so the line ran
 * over: at 60 columns a journal row overflowed by 2 characters. A floor cannot
 * prevent overflow. Only dropping a column, or truncating to what is genuinely
 * left, can — so this does both, in that order.
 *
 * Empty cells are omitted entirely (no double gap), and a cell with no
 * `sacrifice` is load-bearing: the handle you'd paste into `focus` survives
 * even at 40 columns, because a row you can read but can't act on is useless.
 */
function layoutRow(cells: Cell[], width: number, indent = ""): string {
  let live = cells.filter((c) => c.text !== "");
  const fixedWidth = (cs: Cell[]): number =>
    cs.reduce(
      (n, c, i) => n + (c.flex ? 0 : c.text.length) + (i === 0 ? 0 : (c.gap ?? GAP).length),
      indent.length,
    );

  const flex = live.find((c) => c.flex);
  while (width - fixedWidth(live) < (flex ? MIN_FLEX : 0)) {
    // Highest sacrifice first; ties resolve to the rightmost, which reads as
    // "trim from the end".
    let victim = -1;
    let worst = -1;
    live.forEach((c, i) => {
      if (c.sacrifice !== undefined && c.sacrifice >= worst) {
        worst = c.sacrifice;
        victim = i;
      }
    });
    if (victim < 0) break;
    live = live.filter((_, i) => i !== victim);
  }

  const budget = Math.max(1, width - fixedWidth(live));
  return live.reduce((line, c, i) => {
    const text = c.flex ? truncate(c.text, budget) : c.text;
    return line + (i === 0 ? "" : (c.gap ?? GAP)) + (c.paint ? c.paint(text) : text);
  }, indent);
}

/** Host portion of a URL, falling back to the raw string for non-URLs. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** Local wall-clock HH:MM:SS for an epoch-ms timestamp. */
export function clockOf(ts: number, now = new Date(ts)): string {
  if (!Number.isFinite(ts)) return "--:--:--";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
}

/** Compact duration for an elapsed second count (uptime, age). */
export function shortDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "?";
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86_400)}d${Math.floor((s % 86_400) / 3600)}h`;
}

interface TabLike {
  tabId?: string;
  title?: string;
  url?: string;
  active?: boolean;
  pinned?: boolean;
  audible?: boolean;
  muted?: boolean;
  discarded?: boolean;
  frozen?: boolean;
}

interface WindowLike {
  windowId?: string;
  cgWindowId?: number | null;
  state?: string;
  focused?: boolean;
  incognito?: boolean;
  bounds?: { x: number; y: number; w: number; h: number };
  tabs?: TabLike[];
}

interface BrowserLike {
  browser?: string;
  running?: boolean;
  dataSource?: string;
  extensionConnected?: boolean;
  windows?: WindowLike[];
}

interface SnapshotLike {
  browsers?: BrowserLike[];
  focusedBrowser?: string | null;
  generatedAt?: number;
}

/** Compact state flags for one tab, e.g. "pinned audible". */
function tabBadges(t: TabLike): string {
  const on: string[] = [];
  if (t.pinned) on.push("pinned");
  if (t.audible && !t.muted) on.push("audible");
  if (t.muted) on.push("muted");
  if (t.frozen) on.push("frozen");
  else if (t.discarded) on.push("asleep");
  return on.length ? on.join(" ") : "";
}

/**
 * browser → window → tab tree. A flat table cannot show the nesting that makes
 * this data usable (and the TUI already proves the tree reads well).
 */
export function renderSnapshot(snap: SnapshotLike, width = DEFAULT_WIDTH): string {
  const browsers = snap.browsers ?? [];
  if (browsers.length === 0) return "No browsers reported.";
  const out: string[] = [];

  for (const b of browsers) {
    const name = b.browser ?? "?";
    if (!b.running) {
      out.push(`${color.bold(name)} ${color.dim("— not running")}`);
      continue;
    }
    const windows = b.windows ?? [];
    const tabCount = windows.reduce((n, w) => n + (w.tabs?.length ?? 0), 0);
    const src = b.dataSource ?? "?";
    out.push(
      layoutRow(
        [
          { text: name, paint: color.bold },
          {
            text: `${src} · ${plural(windows.length, "window")} · ${plural(tabCount, "tab")}`,
            paint: color.dim,
            flex: true,
          },
          {
            text: snap.focusedBrowser === name ? "← focused" : "",
            paint: color.green,
            sacrifice: 1,
          },
        ],
        width,
      ),
    );

    for (const w of windows) {
      const hasCg = w.cgWindowId != null;
      out.push(
        layoutRow(
          [
            { text: w.windowId ?? "?", paint: color.cyan },
            { text: w.state ?? "normal", paint: color.dim, sacrifice: 3 },
            { text: w.bounds ? `${w.bounds.w}×${w.bounds.h}` : "", paint: color.dim, sacrifice: 4 },
            // The join key. A window with no cgWindowId is the thing you most
            // need to see, so `cg:` outlives every cosmetic column around it.
            {
              text: hasCg ? `cg:${w.cgWindowId}` : "cg:none",
              paint: hasCg ? color.dim : color.yellow,
            },
            { text: w.incognito ? "incognito" : "", paint: color.dim, sacrifice: 2 },
            { text: w.focused ? "focused" : "", paint: color.dim, sacrifice: 1 },
          ],
          width,
          "  ",
        ),
      );

      for (const t of w.tabs ?? []) {
        out.push(
          layoutRow(
            [
              { text: t.active ? "▸" : " ", ...(t.active ? { paint: color.green } : {}) },
              // The handle is what you paste into `focus`/`act`, so it never
              // gets dropped — a row you can read but can't act on is useless.
              { text: t.tabId ?? "?", paint: color.dim, gap: " " },
              { text: t.title ?? "(untitled)", flex: true },
              { text: hostOf(t.url ?? ""), paint: color.dim, sacrifice: 2 },
              { text: tabBadges(t), paint: color.yellow, sacrifice: 3 },
            ],
            width,
            "    ",
          ),
        );
      }
    }
  }
  return out.join("\n");
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

interface JournalRecordLike {
  ts?: number;
  browser?: string;
  kind?: string;
  title?: string;
  url?: string;
  tabId?: string;
  windowId?: string;
}

/**
 * The handle this row is ABOUT — the one you'd act on.
 *
 * `windowMru` answers "which window did I use last", so its answer is a window
 * handle for `focus` / `window set`; every other view is tab-shaped. `nav`
 * records carry no window at all. Falling back keeps a row actionable rather
 * than printing an empty column.
 */
function handleOf(r: JournalRecordLike, section: string, view: string): string {
  if (section === "nav") return r.tabId ?? "?";
  if (view === "windowMru") return r.windowId ?? r.tabId ?? "?";
  return r.tabId ?? r.windowId ?? "?";
}

/** Journal views all carry arrays of focus/nav records; render them uniformly. */
export function renderJournal(value: unknown, width = DEFAULT_WIDTH): string {
  const v = (value ?? {}) as Record<string, unknown>;
  const view = typeof v.view === "string" ? v.view : "journal";
  const sections = Object.entries(v).filter(([, val]) => Array.isArray(val)) as Array<
    [string, JournalRecordLike[]]
  >;
  if (sections.length === 0 || sections.every(([, rows]) => rows.length === 0)) {
    return `${color.bold(view)} ${color.dim("— no records")}`;
  }

  const out: string[] = [];
  for (const [key, rows] of sections) {
    // A journal result carries every view's array, most of them empty. Printing
    // a header per empty section buries the one section that has data.
    if (rows.length === 0) continue;
    out.push(`${color.bold(view)} ${color.dim(`· ${key} · ${plural(rows.length, "record")}`)}`);
    for (const r of rows) {
      out.push(
        layoutRow(
          [
            { text: clockOf(r.ts ?? Number.NaN), paint: color.dim, sacrifice: 2 },
            { text: r.browser ?? "?", sacrifice: 1 },
            { text: (r.kind ?? "?").padEnd(12), paint: color.cyan, sacrifice: 4 },
            // THE POINT OF AN MRU VIEW. Without a handle the output cannot be
            // fed to `focus` / `window set`, which is the only reason to ask
            // "which window did I use last" — so this is never dropped, and at
            // 40 columns it is the last column standing beside the title.
            { text: handleOf(r, key, view), paint: color.cyan },
            { text: r.title ?? r.url ?? "(no title)", flex: true },
            { text: hostOf(r.url ?? ""), paint: color.dim, sacrifice: 3 },
          ],
          width,
          "  ",
        ),
      );
    }
  }
  return out.join("\n");
}

interface HistoryRowLike {
  url?: string;
  title?: string;
  visitTime?: number;
  visitCount?: number;
  browser?: string;
}

interface HistorySourceLike {
  browser?: string;
  source?: string;
  status?: string;
  rows?: number;
  reason?: string;
}

/**
 * Per-source outcome — the field that makes an empty answer legible.
 *
 * `sources` exists because "Chrome-only rows" and "Safari had nothing" and
 * "Safari was never asked" were indistinguishable. Dropping it from the human
 * view reintroduced exactly the ambiguity the field was added to kill, and it
 * matters MOST on the empty path, where there are no rows to reason from — so
 * this prints there too.
 */
function renderSources(sources: HistorySourceLike[], width: number): string[] {
  if (sources.length === 0) return [];
  const paint = (status: string) =>
    status === "error" ? color.red : status === "unavailable" ? color.yellow : color.dim;
  return [
    color.dim("  sources"),
    ...sources.map((s) => {
      const status = s.status ?? "?";
      return layoutRow(
        [
          { text: (s.browser ?? "?").padEnd(8) },
          // At a narrow width the REASON is what you need — losing "extension"
          // vs "safari-db" costs you less than losing "Full Disk Access denied".
          { text: (s.source ?? "?").padEnd(10), paint: color.dim, sacrifice: 1 },
          { text: status.padEnd(11), paint: paint(status) },
          { text: s.reason ?? `${s.rows ?? 0} rows`, paint: color.dim, flex: true },
        ],
        width,
        "    ",
      );
    }),
  ];
}

export function renderHistory(value: unknown, width = DEFAULT_WIDTH): string {
  const v = (value ?? {}) as {
    rows?: HistoryRowLike[];
    truncated?: boolean;
    sources?: HistorySourceLike[];
  };
  const rows = v.rows ?? [];
  const sources = v.sources ?? [];
  if (rows.length === 0) {
    return [`${color.bold("history")} ${color.dim("— no rows")}`, ...renderSources(sources, width)]
      .join("\n")
      .trimEnd();
  }
  const out: string[] = [
    `${color.bold("history")} ${color.dim(`· ${plural(rows.length, "row")}${v.truncated ? " (truncated)" : ""}`)}`,
  ];
  for (const r of rows) {
    out.push(
      layoutRow(
        [
          { text: clockOf(r.visitTime ?? Number.NaN), paint: color.dim, sacrifice: 2 },
          { text: r.browser ?? "?", sacrifice: 1 },
          { text: r.title ?? r.url ?? "", flex: true },
          { text: hostOf(r.url ?? ""), paint: color.dim, sacrifice: 3 },
          {
            text: (r.visitCount ?? 1) > 1 ? `×${r.visitCount}` : "",
            paint: color.dim,
            sacrifice: 4,
          },
        ],
        width,
        "  ",
      ),
    );
  }
  out.push(...renderSources(sources, width));
  return out.join("\n");
}

interface DaemonStatusLike {
  reachable?: boolean;
  pid?: number | null;
  build?: string;
  version?: string;
  socket?: string;
  launchAgent?: string;
  contractVersion?: number;
  wsPort?: number;
  pollMs?: number;
  uptimeS?: number;
  correlationTier?: string;
  subscribers?: number;
  extensionInfo?: Array<{ browser?: string; extVersion?: string; stale?: boolean }>;
}

export function renderDaemonStatus(value: unknown): string {
  const s = (value ?? {}) as DaemonStatusLike;
  const head = s.reachable
    ? `${color.green("● running")}  ${color.dim(`pid ${s.pid ?? "?"} · up ${shortDuration(s.uptimeS ?? Number.NaN)}`)}`
    : color.red("○ not reachable");
  const rows: Array<[string, string]> = [
    ["build", s.build ?? s.version ?? "?"],
    ["socket", s.socket ?? "?"],
    ["launchd", s.launchAgent ?? "?"],
    [
      "wiring",
      `contract v${s.contractVersion ?? "?"} · ws :${s.wsPort ?? "?"} · poll ${s.pollMs ?? "?"}ms · tier ${s.correlationTier ?? "?"}`,
    ],
  ];
  const ext = s.extensionInfo ?? [];
  rows.push([
    "extensions",
    ext.length === 0
      ? color.dim("none connected")
      : ext
          .map(
            (e) =>
              `${e.browser ?? "?"} ${e.extVersion ?? "?"}${e.stale ? color.yellow(" STALE") : ""}`,
          )
          .join(" · "),
  ]);
  if (s.subscribers !== undefined) rows.push(["subscribers", String(s.subscribers)]);

  const pad = Math.max(...rows.map(([k]) => k.length));
  return [
    `${color.bold("daemon")}  ${head}`,
    ...rows.map(([k, v]) => `  ${color.dim(k.padEnd(pad))}  ${v}`),
  ].join("\n");
}

/**
 * Human rendering for a tool result, or `undefined` when the tool has no
 * dedicated renderer — callers fall back to the JSON text block, so adding a
 * tool never silently degrades its output.
 */
export function renderForTool(
  tool: string,
  value: unknown,
  width = DEFAULT_WIDTH,
): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  switch (tool) {
    case "list_tabs":
      return renderSnapshot(value as SnapshotLike, width);
    case "journal":
      return renderJournal(value, width);
    case "history":
      return renderHistory(value, width);
    case "daemon_status":
      return renderDaemonStatus(value);
    default:
      return undefined;
  }
}
