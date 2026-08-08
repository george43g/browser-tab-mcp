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
 * `color` from cli-kit is already a no-op off-TTY, so the expected strings in
 * tests are plain text.
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
    const focused = snap.focusedBrowser === name ? color.green(" ← focused") : "";
    const src = b.dataSource ?? "?";
    out.push(
      `${color.bold(name)}  ${color.dim(`${src} · ${plural(windows.length, "window")} · ${plural(tabCount, "tab")}`)}${focused}`,
    );

    for (const w of windows) {
      const bits = [w.state ?? "normal"];
      if (w.bounds) bits.push(`${w.bounds.w}×${w.bounds.h}`);
      bits.push(w.cgWindowId != null ? `cg:${w.cgWindowId}` : color.yellow("cg:none"));
      if (w.incognito) bits.push("incognito");
      if (w.focused) bits.push("focused");
      out.push(`  ${color.cyan(w.windowId ?? "?")}  ${color.dim(bits.join("  "))}`);

      for (const t of w.tabs ?? []) {
        const marker = t.active ? color.green("▸") : " ";
        const badges = tabBadges(t);
        // Budget the line so the title absorbs the slack: 4 indent + marker + 1
        // + handle + 2 + title + 2 + host (+ 2 + badges) = 10 fixed characters.
        const handle = t.tabId ?? "?";
        const host = hostOf(t.url ?? "");
        const fixed = 10 + handle.length + host.length + (badges ? badges.length + 2 : 0);
        const title = truncate(t.title ?? "(untitled)", Math.max(12, width - fixed));
        const tail = badges ? `  ${color.yellow(badges)}` : "";
        out.push(`    ${marker} ${color.dim(handle)}  ${title}  ${color.dim(host)}${tail}`);
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
      const clock = clockOf(r.ts ?? Number.NaN);
      const kind = (r.kind ?? "?").padEnd(12);
      const host = hostOf(r.url ?? "");
      const fixed =
        2 + clock.length + 2 + (r.browser ?? "").length + 2 + kind.length + host.length + 4;
      const title = truncate(r.title ?? r.url ?? "(no title)", Math.max(12, width - fixed));
      out.push(
        `  ${color.dim(clock)}  ${r.browser ?? "?"}  ${color.cyan(kind)}  ${title}  ${color.dim(host)}`,
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

export function renderHistory(value: unknown, width = DEFAULT_WIDTH): string {
  const v = (value ?? {}) as { rows?: HistoryRowLike[]; truncated?: boolean };
  const rows = v.rows ?? [];
  if (rows.length === 0) return `${color.bold("history")} ${color.dim("— no rows")}`;
  const out: string[] = [
    `${color.bold("history")} ${color.dim(`· ${plural(rows.length, "row")}${v.truncated ? " (truncated)" : ""}`)}`,
  ];
  for (const r of rows) {
    const clock = clockOf(r.visitTime ?? Number.NaN);
    const host = hostOf(r.url ?? "");
    const visits = (r.visitCount ?? 1) > 1 ? `  ${color.dim(`×${r.visitCount}`)}` : "";
    const fixed = 2 + clock.length + 2 + (r.browser ?? "").length + 2 + host.length + 6;
    const title = truncate(r.title ?? r.url ?? "", Math.max(12, width - fixed));
    out.push(`  ${color.dim(clock)}  ${r.browser ?? "?"}  ${title}  ${color.dim(host)}${visits}`);
  }
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
