import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type CommandRunner, parseClientTitles, readTmuxTerminalMap } from "./adapter/processes.js";
import type { TmuxClient, TmuxPane, TmuxSnapshot } from "./model.js";
import type { OsWindowCandidate } from "./terminal-map.js";

const PS_FIXTURE = readFileSync(
  fileURLToPath(new URL("./fixtures/ps-gmac-2026-10-15.txt", import.meta.url)),
  "utf8",
);
const client = (pid: number): TmuxClient => ({
  kind: "client",
  key: `client:${pid}`,
  tty: `/dev/ttys${pid}`,
  name: `/dev/ttys${pid}`,
  pid,
  sessionId: "$0",
});
const pane = (id: string, pid: number): TmuxPane => ({
  kind: "pane",
  key: id,
  id,
  windowId: "@0",
  index: 0,
  title: "",
  command: "zsh",
  path: "/",
  pid,
  width: 80,
  height: 24,
});
const snapshot = (clients: TmuxClient[], panes: TmuxPane[]): TmuxSnapshot => ({
  server: { kind: "server", key: "server:1:1", pid: 1, startTime: 1 },
  sessions: [],
  slots: [],
  windows: [],
  panes,
  clients,
});

/** A fake ps that answers the table read and the args read, and records calls. */
function fakePs(calls: string[][]): CommandRunner {
  return async (args) => {
    calls.push([...args]);
    if (args.includes("pid=,args=")) return "39402 claude --resume abc\n 8355 -zsh\n";
    return PS_FIXTURE;
  };
}
const titles =
  (rows: string): CommandRunner =>
  async () =>
    rows;
const kittyWindow = (windowId: number, title: string): OsWindowCandidate => ({
  windowId,
  ownerPid: 2035,
  w: 1996,
  h: 1269,
  layer: 0,
  title,
});

describe("readTmuxTerminalMap", () => {
  it("joins a client to kitty's single window and names each pane's foreground", async () => {
    const calls: string[][] = [];
    const map = await readTmuxTerminalMap(
      snapshot([client(7059), client(71954)], [pane("%1", 8272), pane("%2", 8355)]),
      {
        ps: fakePs(calls),
        tmux: titles("7059|1|a title\n71954|1|b\n"),
        osWindows: () => [kittyWindow(6183, "a title")],
      },
    );
    expect(map.clients).toEqual([
      {
        clientKey: "client:7059",
        terminal: { app: "kitty", pid: 2035 },
        osWindow: { cgWindowId: 6183, title: "a title" },
      },
      {
        clientKey: "client:71954",
        terminal: null,
        osWindow: null,
        ambiguous: expect.stringContaining("no macOS app among the client's ancestors"),
      },
    ]);
    expect(map.panes).toEqual([
      {
        paneId: "%1",
        shell: { pid: 8272, command: "-zsh" },
        foreground: { pid: 39402, pgid: 39402, command: "claude", args: "claude --resume abc" },
      },
      { paneId: "%2", shell: { pid: 8355, command: "-zsh" }, foreground: null },
    ]);
    expect(calls).toEqual([
      ["-A", "-o", "pid=,ppid=,pgid=,tpgid=,comm="],
      ["-A", "-ww", "-o", "pid=,args="],
    ]);
  });

  it("reports the missing native module as the reason", async () => {
    const map = await readTmuxTerminalMap(snapshot([client(7059)], []), {
      ps: fakePs([]),
      tmux: titles("7059|1|x\n"),
      osWindows: null,
      osWindowsUnavailable: "the rust-accel native module is not built",
    });
    expect(map.clients[0]).toEqual({
      clientKey: "client:7059",
      terminal: { app: "kitty", pid: 2035 },
      osWindow: null,
      ambiguous: "the rust-accel native module is not built",
    });
  });

  it("refuses a window that two clients both claim by title", async () => {
    // Two clients in one kitty, both rendering the title of window 6183 (one
    // of them in a background tab): only one is shown there, so neither is named.
    const ps: CommandRunner = async (args) =>
      args.includes("pid=,args=") ? "" : `${PS_FIXTURE} 7070  2070  7070  7059 tmux\n`;
    const map = await readTmuxTerminalMap(snapshot([client(7059), client(7070)], []), {
      ps,
      tmux: titles("7059|1|same\n7070|1|same\n"),
      osWindows: () => [kittyWindow(6183, "same"), kittyWindow(7000, "other")],
    });
    for (const placement of map.clients) {
      expect(placement.osWindow).toBeNull();
      expect(placement.ambiguous).toBe(
        "2 clients (client:7059, client:7070) render the title of window 6183",
      );
    }
  });

  it("turns a throwing window source into a reason, not a failed read", async () => {
    const map = await readTmuxTerminalMap(snapshot([client(7059)], []), {
      ps: fakePs([]),
      tmux: titles("7059|1|x\n"),
      osWindows: () => {
        throw new Error("boom");
      },
    });
    expect(map.clients[0]?.ambiguous).toBe("the CoreGraphics window list failed: boom");
  });

  it("skips the args scan when there are no panes", async () => {
    const calls: string[][] = [];
    await readTmuxTerminalMap(snapshot([], []), { ps: fakePs(calls) });
    expect(calls).toEqual([["-A", "-o", "pid=,ppid=,pgid=,tpgid=,comm="]]);
  });
});

describe("parseClientTitles", () => {
  it("keeps separators inside the title and drops a newline's continuation", () => {
    expect(parseClientTitles("7059|1|host ❐ a|b ● 1 x\n71954|0|\n7070|1|first\nsecond\n")).toEqual(
      new Map([
        [7059, { setTitles: true, title: "host ❐ a|b ● 1 x" }],
        [71954, { setTitles: false, title: "" }],
        [7070, { setTitles: true, title: "first" }],
      ]),
    );
  });
});
