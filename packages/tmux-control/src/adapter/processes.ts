import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type {
  TmuxClientPlacement,
  TmuxPaneProcesses,
  TmuxSnapshot,
  TmuxTerminalApp,
  TmuxTerminalMap,
} from "../model.js";
import {
  findPaneProcesses,
  findTerminalApp,
  matchOsWindow,
  type OsWindowCandidate,
  type OsWindowResult,
  PS_ARGS_ARGS,
  PS_TABLE_ARGS,
  parseArgsTable,
  parseProcessTable,
  type RenderedTitle,
} from "../terminal-map.js";
import { runTmux, type TmuxConnection } from "./read.js";

const execFileAsync = promisify(execFile);

/** argv in, stdout out. The ps boundary; tests pass a fake. */
export type CommandRunner = (args: readonly string[], signal?: AbortSignal) => Promise<string>;

/**
 * `ps` exits 1 when a `-p` pid has gone, yet still prints the rows that exist;
 * those rows are the answer, so a status-1 exit with output is not a failure.
 */
export const runPs: CommandRunner = async (args, signal) => {
  try {
    const { stdout } = await execFileAsync("ps", [...args], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 5000,
      ...(signal === undefined ? {} : { signal }),
    });
    return stdout;
  } catch (error) {
    const e = error as { stdout?: unknown; code?: unknown };
    if (signal?.aborted) throw error;
    if (e.code === 1 && typeof e.stdout === "string") return e.stdout;
    throw new Error(`ps ${args.join(" ")} failed; check that ps is on PATH and retry.`);
  }
};

/**
 * Per-client rendered title. `T:` expands set-titles-string the way tmux does
 * for the terminal. No `q:`: combined as `T;q:` it quotes the TEMPLATE before
 * expansion (measured on tmux 3.7b), so expanded values stay raw. The title is
 * therefore last, and everything after the second `|` belongs to it.
 */
export const CLIENT_TITLE_FORMAT = "#{client_pid}|#{set-titles}|#{T:set-titles-string}";

const TITLE_ROW = /^(\d+)\|([01])\|(.*)$/;

/**
 * A title with a newline in it splits across lines; its first line then
 * matches no window exactly and the client resolves to null, never a guess.
 */
export function parseClientTitles(output: string): Map<number, RenderedTitle> {
  const titles = new Map<number, RenderedTitle>();
  for (const line of output.split("\n")) {
    const match = TITLE_ROW.exec(line);
    if (match) {
      titles.set(Number(match[1]), { setTitles: match[2] === "1", title: match[3] as string });
    }
  }
  return titles;
}

export interface TerminalMapOptions {
  connection?: TmuxConnection;
  /** Defaults to the real `ps`. */
  ps?: CommandRunner;
  /** Defaults to tmux on `connection`'s socket. */
  tmux?: CommandRunner;
  /** rust-accel's `listCgWindowsOfPid`; null or absent when unavailable. */
  osWindows?: ((pid: number) => readonly OsWindowCandidate[]) | null;
  /** Why `osWindows` is null, for the `ambiguous` reason. */
  osWindowsUnavailable?: string;
}

/**
 * Map each client to its terminal app and OS window (`cgWindowId` equals
 * yabai's window id), and each pane to its shell and foreground process.
 * Read-only. Clients and panes that vanish after `snapshot` come back null.
 */
export async function readTmuxTerminalMap(
  snapshot: TmuxSnapshot,
  options: TerminalMapOptions = {},
): Promise<TmuxTerminalMap> {
  const connection = options.connection ?? {};
  const signal = connection.signal;
  const ps = options.ps ?? runPs;
  const tmux = options.tmux ?? ((args) => runTmux(connection, [...args]));
  // Command lines come from a second whole-table scan, not `ps -p <pids>`:
  // macOS ps scans once per -p pid (0.6 s for 28 pids against 0.09 s for -A,
  // measured on gmac 2026-10-15).
  const [psOutput, argsOutput, titleOutput] = await Promise.all([
    ps(PS_TABLE_ARGS, signal),
    snapshot.panes.length === 0 ? Promise.resolve("") : ps(PS_ARGS_ARGS, signal),
    snapshot.clients.length === 0
      ? Promise.resolve("")
      : tmux(["list-clients", "-F", CLIENT_TITLE_FORMAT], signal),
  ]);
  if (signal?.aborted) throw new Error("Cancelled by client");
  const table = parseProcessTable(psOutput);
  const titles = parseClientTitles(titleOutput);

  const windowsByPid = new Map<number, readonly OsWindowCandidate[] | null>();
  let unavailable = options.osWindowsUnavailable ?? "no CoreGraphics window source is available";
  const windowsOf = (terminal: TmuxTerminalApp) => {
    if (!windowsByPid.has(terminal.pid)) {
      let windows: readonly OsWindowCandidate[] | null = null;
      if (options.osWindows) {
        try {
          windows = options.osWindows(terminal.pid);
        } catch (error) {
          unavailable = `the CoreGraphics window list failed: ${(error as Error).message}`;
        }
      }
      windowsByPid.set(terminal.pid, windows);
    }
    return windowsByPid.get(terminal.pid) ?? null;
  };

  const matched: { placement: TmuxClientPlacement; result: OsWindowResult | null }[] =
    snapshot.clients.map((client) => {
      const found = findTerminalApp(client.pid, table);
      if (found.terminal === null) {
        return {
          placement: {
            clientKey: client.key,
            terminal: null,
            osWindow: null,
            ambiguous: found.reason,
          },
          result: null,
        };
      }
      const result = matchOsWindow(
        found.terminal,
        windowsOf(found.terminal),
        titles.get(client.pid),
        unavailable,
      );
      return {
        placement: {
          clientKey: client.key,
          terminal: found.terminal,
          osWindow: result.osWindow,
          ...(result.osWindow === null ? { ambiguous: result.reason } : {}),
        },
        result,
      };
    });

  // A title can match one window for two clients (one of them in a background
  // tab of that window). Only one of them is shown there, so name neither.
  const claims = new Map<number, string[]>();
  for (const { placement, result } of matched) {
    if (result?.byTitle && placement.osWindow) {
      const id = placement.osWindow.cgWindowId;
      claims.set(id, [...(claims.get(id) ?? []), placement.clientKey]);
    }
  }
  for (const { placement, result } of matched) {
    const id = placement.osWindow?.cgWindowId;
    const claimants = id === undefined ? undefined : claims.get(id);
    if (result?.byTitle && claimants && claimants.length > 1) {
      placement.osWindow = null;
      placement.ambiguous = `${claimants.length} clients (${claimants.join(", ")}) render the title of window ${id}`;
    }
  }

  const panes = snapshot.panes.map((pane) => ({
    paneId: pane.id,
    ...findPaneProcesses(pane.pid, table),
  }));
  const args = parseArgsTable(argsOutput);

  return {
    clients: matched.map(({ placement }) => placement),
    panes: panes.map(
      (pane): TmuxPaneProcesses => ({
        paneId: pane.paneId,
        shell: pane.shell,
        foreground: pane.foreground
          ? { ...pane.foreground, args: args.get(pane.foreground.pid) ?? pane.foreground.command }
          : null,
      }),
    ),
  };
}
