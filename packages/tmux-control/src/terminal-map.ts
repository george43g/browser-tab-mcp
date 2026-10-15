/**
 * Pure rules for "which terminal OS window shows which tmux client, and what
 * each pane runs" (plan §1b, option A). No I/O: the adapter feeds in a `ps`
 * table, the titles tmux renders per client, and a CoreGraphics window list.
 *
 * Never a guess: every rule returns null with a reason rather than pick one
 * of several candidates.
 */
import type { TmuxForegroundProcess, TmuxOsWindow, TmuxProcess, TmuxTerminalApp } from "./model.js";

/** One `ps -o pid=,ppid=,pgid=,tpgid=,comm=` row. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  pgid: number;
  /** Foreground process group of the controlling tty; 0 or -1 when none. */
  tpgid: number;
  /** Executable; macOS prints the full path, e.g. `/Applications/kitty.app/Contents/MacOS/kitty`. */
  comm: string;
}

export type ProcessTable = ReadonlyMap<number, ProcessRow>;

/** The columns `parseProcessTable` expects, in order. */
export const PS_TABLE_ARGS = ["-A", "-o", "pid=,ppid=,pgid=,tpgid=,comm="] as const;

const PS_ROW = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(.*)$/;

/** Parse `ps -A -o pid=,ppid=,pgid=,tpgid=,comm=`. comm is last because it may contain spaces. */
export function parseProcessTable(output: string): Map<number, ProcessRow> {
  const table = new Map<number, ProcessRow>();
  for (const line of output.split("\n")) {
    const match = PS_ROW.exec(line);
    if (!match) continue;
    const [, pid, ppid, pgid, tpgid, comm] = match;
    table.set(Number(pid), {
      pid: Number(pid),
      ppid: Number(ppid),
      pgid: Number(pgid),
      tpgid: Number(tpgid),
      comm: (comm as string).trimEnd(),
    });
  }
  return table;
}

/** Every process's full command line, for `parseArgsTable`. */
export const PS_ARGS_ARGS = ["-A", "-ww", "-o", "pid=,args="] as const;

/** Parse `ps -A -ww -o pid=,args=`. */
export function parseArgsTable(output: string): Map<number, string> {
  const args = new Map<number, string>();
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s(.*)$/.exec(line);
    if (match) args.set(Number(match[1]), (match[2] as string).trim());
  }
  return args;
}

function shortName(comm: string): string {
  return comm.slice(comm.lastIndexOf("/") + 1) || comm;
}

/**
 * `/…/Name.app/Contents/MacOS/exe` → `Name`, for a TOP-LEVEL bundle only.
 * A helper nested in another bundle (`Code.app/…/Code Helper.app/…`) owns no
 * windows, so it is skipped and the walk continues to the app that does.
 */
export function appBundleName(comm: string): string | null {
  const match = /^(.*)\/([^/]+)\.app\/Contents\/MacOS\/[^/]+$/.exec(comm);
  if (!match) return null;
  if ((match[1] as string).includes(".app/")) return null;
  return match[2] as string;
}

export type TerminalResult =
  | { terminal: TmuxTerminalApp; reason?: undefined }
  | { terminal: null; reason: string };

/**
 * Walk the client's parent chain to the nearest GUI app. The client's parent is
 * not the terminal: it is the shell the terminal started (measured on gmac:
 * tmux 7059 → zsh 2070 → kitty 2035).
 */
export function findTerminalApp(clientPid: number, table: ProcessTable): TerminalResult {
  const chain: string[] = [];
  const seen = new Set<number>();
  let pid = clientPid;
  while (pid > 1 && !seen.has(pid)) {
    seen.add(pid);
    const row = table.get(pid);
    if (!row) {
      if (pid === clientPid) {
        return { terminal: null, reason: `tmux client process ${clientPid} was not found by ps` };
      }
      break;
    }
    const app = appBundleName(row.comm);
    if (app !== null) return { terminal: { app, pid } };
    chain.push(`${shortName(row.comm)} ${pid}`);
    pid = row.ppid;
  }
  return {
    terminal: null,
    reason: `no macOS app among the client's ancestors (${chain.join(" → ")}): a control-mode, ssh or launchd-spawned client, or a terminal whose sessions are not its children`,
  };
}

export interface PaneProcessResult {
  shell: TmuxProcess | null;
  foreground: Omit<TmuxForegroundProcess, "args"> | null;
}

/**
 * The pane's shell is `#{pane_pid}`. The running program is the leader of the
 * tty's foreground process group (the shell row's `tpgid`). A background
 * group on the same tty (gitstatusd) is never picked, because only the
 * foreground group is consulted.
 */
export function findPaneProcesses(shellPid: number, table: ProcessTable): PaneProcessResult {
  const shellRow = table.get(shellPid);
  if (!shellRow) return { shell: null, foreground: null };
  const shell = { pid: shellPid, command: shellRow.comm };
  const group = shellRow.tpgid;
  if (group <= 0 || group === shellRow.pgid) return { shell, foreground: null };
  let leader = table.get(group);
  if (!leader || leader.pgid !== group) {
    // The leader exited while its group still holds the tty: name the oldest member.
    leader = [...table.values()]
      .filter((row) => row.pgid === group)
      .sort((a, b) => a.pid - b.pid)[0];
  }
  if (!leader) return { shell, foreground: null };
  return { shell, foreground: { pid: leader.pid, pgid: group, command: leader.comm } };
}

/** One CG window, as rust-accel's `listCgWindowsOfPid` returns it. */
export interface OsWindowCandidate {
  windowId: number;
  ownerPid: number;
  w: number;
  h: number;
  layer: number;
  /** Absent without Screen Recording consent. */
  title?: string | undefined;
}

/** What tmux renders as this client's terminal title. */
export interface RenderedTitle {
  setTitles: boolean;
  title: string;
}

/**
 * Smallest side, in points, of a window that can hold a terminal. Measured on
 * gmac 2026-10-15: kitty pid 2035 owned 25 layer-0 CG windows, of which one
 * (6183, 1996x1269) was its terminal and the only one yabai listed. The rest
 * were menu-bar strips (1920x24 or 2056x43, one per display and Space, title
 * ""), a 54x54 window, and 0x0 helpers (one titled "temp").
 */
export const MIN_WINDOW_SIDE = 100;

export type OsWindowResult =
  | { osWindow: TmuxOsWindow; byTitle: boolean; reason?: undefined }
  | { osWindow: null; byTitle: false; reason: string };

function quote(text: string): string {
  return JSON.stringify(text);
}

/**
 * Option A: CoreGraphics pid, then the title tmux renders for this client.
 * `windows` is null when the native module is unavailable; `nativeReason`
 * says why.
 */
export function matchOsWindow(
  terminal: TmuxTerminalApp,
  windows: readonly OsWindowCandidate[] | null,
  rendered: RenderedTitle | undefined,
  nativeReason = "the CoreGraphics native module is unavailable",
): OsWindowResult {
  if (windows === null) return { osWindow: null, byTitle: false, reason: nativeReason };
  const label = `${terminal.app} (pid ${terminal.pid})`;
  const candidates = windows.filter(
    (window) =>
      window.ownerPid === terminal.pid &&
      window.layer === 0 &&
      window.w >= MIN_WINDOW_SIDE &&
      window.h >= MIN_WINDOW_SIDE &&
      window.title !== "",
  );
  const only = candidates[0];
  if (candidates.length === 1 && only) {
    return {
      osWindow: { cgWindowId: only.windowId, title: only.title ?? null },
      byTitle: false,
    };
  }
  if (candidates.length === 0) {
    return { osWindow: null, byTitle: false, reason: `${label} owns no normal window` };
  }
  const shared = `${candidates.length} ${terminal.app} windows share pid ${terminal.pid}`;
  if (!rendered) {
    return { osWindow: null, byTitle: false, reason: `${shared} and tmux reported no title` };
  }
  if (!rendered.setTitles) {
    return {
      osWindow: null,
      byTitle: false,
      reason: `${shared} and tmux set-titles is off, so no title tells them apart`,
    };
  }
  if (candidates.every((window) => window.title === undefined)) {
    return {
      osWindow: null,
      byTitle: false,
      reason: `${shared} and their titles are unreadable (this process lacks Screen Recording consent)`,
    };
  }
  const matches = candidates.filter((window) => window.title === rendered.title);
  const match = matches[0];
  if (matches.length === 1 && match) {
    return {
      osWindow: { cgWindowId: match.windowId, title: match.title ?? null },
      byTitle: true,
    };
  }
  if (matches.length === 0) {
    return {
      osWindow: null,
      byTitle: false,
      reason: `${shared} and none has this client's title ${quote(rendered.title)} (it may be in a background tab)`,
    };
  }
  return {
    osWindow: null,
    byTitle: false,
    reason: `${matches.length} ${terminal.app} windows share pid ${terminal.pid} and the title ${quote(rendered.title)}`,
  };
}
