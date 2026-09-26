import { execFile } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import type {
  TmuxClient,
  TmuxPane,
  TmuxSession,
  TmuxSlot,
  TmuxSnapshot,
  TmuxWindow,
} from "../model.js";

const execFileAsync = promisify(execFile);

/** The only tmux process boundary in the package. No caller text enters a shell. */
export interface TmuxConnection {
  /** A named tmux socket, passed as `-L`; omitted to use tmux's normal server. */
  socketName?: string;
  /** Dependency injection for a missing-binary test; never exposed by the MCP tool. */
  binary?: string;
  signal?: AbortSignal;
}

export class TmuxUnavailableError extends Error {
  constructor(
    message: string,
    readonly reason: "binary-missing" | "server-missing" | "command-failed" | "snapshot-changed",
  ) {
    super(message);
    this.name = "TmuxUnavailableError";
  }
}

export const TMUX_FORMATS = {
  server: "#{pid}|#{start_time}",
  sessions: "#{session_id}|#{q:session_name}|#{session_windows}|#{session_attached}",
  slots:
    "#{session_id}|#{window_id}|#{window_index}|#{q:window_name}|#{q:window_layout}|#{window_active}|#{window_width}|#{window_height}",
  panes:
    "#{window_id}|#{pane_id}|#{pane_index}|#{q:pane_title}|#{q:pane_current_command}|#{q:pane_current_path}|#{pane_pid}|#{pane_width}|#{pane_height}",
  clients:
    "#{q:client_tty}|#{q:client_name}|#{client_pid}|#{session_id}|#{client_width}|#{client_height}",
} as const;

/** tmux's q: modifier backslash-quotes field separators, spaces and backslashes. */
export function parseTmuxRow(line: string, fields: number): string[] {
  const parts: string[] = [];
  let part = "";
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === "\\") {
      const next = line[++i];
      if (next === undefined) throw new Error("Incomplete tmux format escape");
      part += next;
    } else if (char === "|") {
      parts.push(part);
      part = "";
    } else {
      part += char;
    }
  }
  parts.push(part);
  if (parts.length !== fields) {
    throw new Error(`Expected ${fields} tmux fields, received ${parts.length}`);
  }
  return parts;
}

function parseRows(output: string, fields: number): string[][] {
  return output
    .replace(/\n$/, "")
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => parseTmuxRow(line, fields));
}

function integer(raw: string, field: string): number {
  if (!/^\d+$/.test(raw)) throw new Error(`Invalid numeric tmux field: ${field}`);
  return Number(raw);
}

function projectOf(path: string): string | undefined {
  if (!isAbsolute(path)) return undefined;
  let dir = path;
  for (;;) {
    const marker = join(dir, ".git");
    if (existsSync(marker)) {
      try {
        const stat = statSync(marker);
        if (stat.isFile() && stat.size <= 4096) {
          const pointer = /^gitdir: (.+)$/m.exec(readFileSync(marker, "utf8"))?.[1];
          if (pointer) {
            const worktreeDir = dirname(resolve(dir, pointer));
            const commonDir = dirname(worktreeDir);
            if (basename(worktreeDir) === "worktrees" && basename(commonDir) === ".git") {
              return basename(dirname(commonDir));
            }
          }
        }
      } catch {
        // An unreadable marker still names the containing worktree.
      }
      return basename(dir);
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

async function run(connection: TmuxConnection, args: string[]): Promise<string> {
  const binary = connection.binary ?? "tmux";
  const socket = connection.socketName === undefined ? [] : ["-L", connection.socketName];
  try {
    const { stdout } = await execFileAsync(binary, [...socket, ...args], {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 5000,
      signal: connection.signal,
    });
    return stdout;
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stderr?: string };
    if (e.code === "ENOENT") {
      throw new TmuxUnavailableError(
        "tmux is not installed or not on PATH; install tmux and retry.",
        "binary-missing",
      );
    }
    if (/no server running|failed to connect to server|error connecting to/i.test(e.stderr ?? "")) {
      throw new TmuxUnavailableError(
        "No tmux server is running on the selected socket; start a tmux session and retry.",
        "server-missing",
      );
    }
    if (connection.signal?.aborted) throw error;
    throw new TmuxUnavailableError(
      `tmux ${args[0] ?? "command"} failed; check the selected socket and retry.`,
      "command-failed",
    );
  }
}

/** Check the binary without starting or connecting to a server. */
export async function probeTmuxBinary(binary = "tmux"): Promise<string> {
  return (await run({ binary }, ["-V"])).trim();
}

export interface TmuxRawSnapshot {
  server: string;
  sessions: string;
  slots: string;
  panes: string;
  clients: string;
}

/** Parse captured `-F` output as well as live reads through the same path. */
export function parseTmuxSnapshot(raw: TmuxRawSnapshot): TmuxSnapshot {
  const sessions = parseRows(raw.sessions, 4).map(
    ([id, name, count, attached]): TmuxSession => ({
      kind: "session",
      key: id as string,
      id: id as string,
      name: name as string,
      windowCount: integer(count as string, "session_windows"),
      attached: attached === "1",
    }),
  );
  const first = sessions[0];
  if (!first) {
    throw new TmuxUnavailableError(
      "No tmux sessions exist; create one and retry.",
      "server-missing",
    );
  }
  const [serverPid, startTime] = parseTmuxRow(raw.server.trim(), 2);
  const slotRows = parseRows(raw.slots, 8);
  const windowsById = new Map<string, TmuxWindow>();
  const slots: TmuxSlot[] = slotRows.map(
    ([sessionId, windowId, index, name, layout, active, width, height]) => {
      const id = windowId as string;
      const window: TmuxWindow = {
        kind: "window",
        key: id,
        id,
        name: name as string,
        layout: layout as string,
        width: integer(width as string, "window_width"),
        height: integer(height as string, "window_height"),
      };
      const prior = windowsById.get(id);
      if (prior && JSON.stringify(prior) !== JSON.stringify(window)) {
        throw new Error(`tmux window ${id} changed during the snapshot; retry.`);
      }
      windowsById.set(id, window);
      return {
        kind: "slot",
        key: `${sessionId}:${id}`,
        sessionId: sessionId as string,
        windowId: id,
        index: integer(index as string, "window_index"),
        active: active === "1",
      };
    },
  );
  const panesById = new Map<string, TmuxPane>();
  for (const [windowId, paneId, index, title, command, path, pid, width, height] of parseRows(
    raw.panes,
    9,
  )) {
    const pane: TmuxPane = {
      kind: "pane",
      key: paneId as string,
      id: paneId as string,
      windowId: windowId as string,
      index: integer(index as string, "pane_index"),
      title: title as string,
      command: command as string,
      path: path as string,
      pid: integer(pid as string, "pane_pid"),
      width: integer(width as string, "pane_width"),
      height: integer(height as string, "pane_height"),
    };
    const project = projectOf(pane.path);
    if (project !== undefined) pane.project = project;
    const prior = panesById.get(pane.id);
    if (prior && JSON.stringify(prior) !== JSON.stringify(pane)) {
      throw new Error(`tmux pane ${pane.id} changed during the snapshot; retry.`);
    }
    panesById.set(pane.id, pane);
  }
  const clients = parseRows(raw.clients, 6).map(
    ([tty, name, pid, sessionId, width, height]): TmuxClient => ({
      kind: "client",
      key: `client:${pid}`,
      tty: tty as string,
      name: name as string,
      pid: integer(pid as string, "client_pid"),
      sessionId: sessionId as string,
      ...(width ? { width: integer(width, "client_width") } : {}),
      ...(height ? { height: integer(height, "client_height") } : {}),
    }),
  );
  const sessionIds = new Set(sessions.map((session) => session.id));
  for (const session of sessions) {
    if (slots.filter((slot) => slot.sessionId === session.id).length !== session.windowCount) {
      throw new Error(`tmux session ${session.id} changed while reading its window slots; retry.`);
    }
  }
  for (const slot of slots) {
    if (!sessionIds.has(slot.sessionId) || !windowsById.has(slot.windowId)) {
      throw new Error(`tmux slot ${slot.key} has a missing session or window; retry.`);
    }
  }
  for (const pane of panesById.values()) {
    if (!windowsById.has(pane.windowId)) {
      throw new Error(`tmux pane ${pane.id} has a missing window; retry.`);
    }
  }
  for (const client of clients) {
    if (!sessionIds.has(client.sessionId)) {
      throw new Error(`tmux client ${client.key} has a missing session; retry.`);
    }
  }
  return {
    server: {
      kind: "server",
      key: `server:${serverPid}:${startTime}`,
      pid: integer(serverPid as string, "server_pid"),
      startTime: integer(startTime as string, "start_time"),
    },
    sessions,
    slots,
    windows: [...windowsById.values()],
    panes: [...panesById.values()],
    clients,
  };
}

function structuralRows(slots: string, panes: string): string {
  const slotKeys = parseRows(slots, 8).map(([sessionId, windowId, index, , layout, active]) =>
    [sessionId, windowId, index, layout, active].join("|"),
  );
  const paneKeys = parseRows(panes, 9).map(([windowId, paneId, index, , , , pid, width, height]) =>
    [windowId, paneId, index, pid, width, height].join("|"),
  );
  return JSON.stringify([slotKeys, paneKeys]);
}

export async function readTmuxSnapshot(connection: TmuxConnection = {}): Promise<TmuxSnapshot> {
  const sessions = await run(connection, ["list-sessions", "-F", TMUX_FORMATS.sessions]);
  const first = parseRows(sessions, 4)[0]?.[0];
  if (!first) {
    throw new TmuxUnavailableError(
      "No tmux sessions exist; create one and retry.",
      "server-missing",
    );
  }
  const [server, slots, panes, clients] = await Promise.all([
    run(connection, ["display-message", "-p", "-t", first, TMUX_FORMATS.server]),
    run(connection, ["list-windows", "-a", "-F", TMUX_FORMATS.slots]),
    run(connection, ["list-panes", "-a", "-F", TMUX_FORMATS.panes]),
    run(connection, ["list-clients", "-F", TMUX_FORMATS.clients]),
  ]);
  const [endServer, endSessions, endSlots, endPanes, endClients] = await Promise.all([
    run(connection, ["display-message", "-p", "-t", first, TMUX_FORMATS.server]),
    run(connection, ["list-sessions", "-F", TMUX_FORMATS.sessions]),
    run(connection, ["list-windows", "-a", "-F", TMUX_FORMATS.slots]),
    run(connection, ["list-panes", "-a", "-F", TMUX_FORMATS.panes]),
    run(connection, ["list-clients", "-F", TMUX_FORMATS.clients]),
  ]);
  if (
    server !== endServer ||
    sessions !== endSessions ||
    clients !== endClients ||
    structuralRows(slots, panes) !== structuralRows(endSlots, endPanes)
  ) {
    throw new TmuxUnavailableError(
      "tmux structure changed while reading the snapshot; retry the list call.",
      "snapshot-changed",
    );
  }
  return parseTmuxSnapshot({ server, sessions, slots, panes, clients });
}
