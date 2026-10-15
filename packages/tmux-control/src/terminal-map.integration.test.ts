import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  CLIENT_TITLE_FORMAT,
  parseClientTitles,
  readTmuxTerminalMap,
} from "./adapter/processes.js";
import { readTmuxSnapshot, runTmux } from "./adapter/read.js";

const available = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;
const effectIt = available ? it : it.skip;
const socket = `tmux-map-test-${process.pid}-${Date.now()}`;
const tmux = (...args: string[]) =>
  spawnSync("tmux", ["-L", socket, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, TMUX: "" },
  });
const paneId = (target: string) =>
  tmux("display-message", "-p", "-t", target, "#{pane_id}").stdout.trim();
let client: ChildProcess | undefined;

beforeAll(async () => {
  if (!available) return;
  // /bin/sh, not the user's shell: no rc files, so no prompt helpers on the tty.
  expect(
    tmux("-f", "/dev/null", "new-session", "-d", "-s", "map", "-n", "busy|win", "/bin/sh").status,
  ).toBe(0);
  expect(tmux("split-window", "-d", "-t", "map:0", "/bin/sh").status).toBe(0);
  expect(tmux("new-window", "-d", "-t", "map:1", "sleep 60").status).toBe(0);
  expect(tmux("set-option", "-g", "set-titles", "on").status).toBe(0);
  expect(tmux("set-option", "-g", "set-titles-string", "#S|#W").status).toBe(0);
  expect(tmux("send-keys", "-t", "map:0.0", "sleep 61", "Enter").status).toBe(0);
  client = spawn("tmux", ["-L", socket, "-C", "attach", "-t", "map"], {
    stdio: ["pipe", "ignore", "ignore"],
    env: { ...process.env, TMUX: "" },
  });
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const busy = tmux("display-message", "-p", "-t", "map:0.0", "#{pane_current_command}");
    const attached = tmux("list-clients", "-F", "#{client_pid}").stdout.trim();
    if (busy.stdout.trim() === "sleep" && attached) return;
    await delay(50);
  }
  throw new Error("sleep never reached the foreground of map:0.0, or no client attached");
});

afterAll(() => {
  client?.kill();
  if (available) tmux("kill-server");
});

effectIt("a pane's foreground is the running program, and null at an idle prompt", async () => {
  const snapshot = await readTmuxSnapshot({ socketName: socket });
  const map = await readTmuxTerminalMap(snapshot, { connection: { socketName: socket } });
  const byId = new Map(map.panes.map((pane) => [pane.paneId, pane]));

  const busy = byId.get(paneId("map:0.0"));
  const busyShellPid = snapshot.panes.find((pane) => pane.id === paneId("map:0.0"))?.pid;
  expect(busy?.shell).toEqual({ pid: busyShellPid, command: expect.stringMatching(/sh$/) });
  expect(busy?.foreground?.command).toMatch(/sleep$/);
  expect(busy?.foreground?.args).toBe("sleep 61");
  expect(busy?.foreground?.pid).not.toBe(busyShellPid);
  expect(busy?.foreground?.pgid).toBe(busy?.foreground?.pid);

  expect(byId.get(paneId("map:0.1"))?.foreground).toBeNull();
  // A pane whose own process is the program: that process IS the shell slot.
  const direct = byId.get(paneId("map:1"));
  expect(direct?.shell?.command).toMatch(/sleep$/);
  expect(direct?.foreground).toBeNull();
});

effectIt("every client gets a placement, and osWindow is null with a reason here", async () => {
  const snapshot = await readTmuxSnapshot({ socketName: socket });
  const map = await readTmuxTerminalMap(snapshot, { connection: { socketName: socket } });
  expect(map.clients.map((placement) => placement.clientKey)).toEqual(
    snapshot.clients.map((c) => c.key),
  );
  // A control-mode client: under CI no app is an ancestor; on a desktop the
  // test runner's own terminal is. No window source is passed, so osWindow
  // is null with a reason either way.
  for (const placement of map.clients) {
    expect(placement.osWindow).toBeNull();
    expect(placement.ambiguous).toEqual(expect.any(String));
  }
});

effectIt("tmux expands each client's set-titles-string, separators included", async () => {
  const titles = parseClientTitles(
    await runTmux({ socketName: socket }, ["list-clients", "-F", CLIENT_TITLE_FORMAT]),
  );
  const pid = Number(tmux("list-clients", "-F", "#{client_pid}").stdout.trim());
  expect(titles.get(pid)).toEqual({ setTitles: true, title: "map|busy|win" });
});
