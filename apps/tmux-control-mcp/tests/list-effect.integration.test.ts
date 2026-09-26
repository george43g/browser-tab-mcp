import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { callMcpTool } from "../src/dispatcher.js";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(APP_DIR, "dist", "cli.js");
const available = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;
const socket = `codex-m2-test-${process.pid}-${Date.now()}`;
let client: ChildProcess | undefined;
const runTmux = (...args: string[]) =>
  spawnSync("tmux", ["-L", socket, ...args], { encoding: "utf8", timeout: 10_000 });

beforeAll(async () => {
  if (!available) return;
  expect(existsSync(BIN), "Build the bin before the tmux-effect tier runs").toBe(true);
  expect(
    runTmux(
      "-f",
      "/dev/null",
      "new-session",
      "-d",
      "-s",
      "sample",
      "-n",
      "Agent| One",
      "-c",
      APP_DIR,
      "sleep 60",
    ).status,
  ).toBe(0);
  expect(runTmux("split-window", "-d", "-t", "sample:0", "-c", APP_DIR, "sleep 60").status).toBe(0);
  expect(
    runTmux("new-session", "-d", "-s", "linked", "-n", "spare", "-c", APP_DIR, "sleep 60").status,
  ).toBe(0);
  expect(runTmux("link-window", "-d", "-s", "sample:0", "-t", "linked:1").status).toBe(0);
  client = spawn("tmux", ["-L", socket, "-C", "attach", "-t", "sample"], {
    stdio: ["pipe", "ignore", "ignore"],
    env: { ...process.env, TMUX: "" },
  });
  let connected = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (runTmux("list-clients", "-F", "#{client_pid}").stdout.trim()) {
      connected = true;
      break;
    }
    await delay(50);
  }
  expect(connected, "A real control client must attach for the client effect check").toBe(true);
});

afterAll(() => {
  client?.kill();
  if (available) runTmux("kill-server");
});

const effectIt = available ? it : it.skip;

effectIt("built list reads a real throwaway tmux server (requires tmux on PATH)", () => {
  const result = spawnSync(process.execPath, [BIN, "--json", "list", "--socket-name", socket], {
    encoding: "utf8",
    timeout: 10_000,
  });
  expect(result.status, result.stderr).toBe(0);
  const data = JSON.parse(result.stdout) as {
    sessions: { id: string; name: string }[];
    slots: { sessionId: string; windowId: string }[];
    windows: { id: string; name: string }[];
    panes: { windowId: string; project?: string }[];
    clients: { pid: number; sessionId: string }[];
  };
  expect(data.sessions).toHaveLength(2);
  expect(data.slots).toHaveLength(3);
  const linked = data.windows.find((window) => window.name.includes("Agent| One"));
  expect(linked).toBeDefined();
  expect(data.slots.filter((slot) => slot.windowId === linked?.id)).toHaveLength(2);
  expect(data.windows.filter((window) => window.id === linked?.id)).toHaveLength(1);
  expect(data.panes.filter((pane) => pane.windowId === linked?.id)).toHaveLength(2);
  expect(data.clients).toHaveLength(1);
  expect(data.clients[0]?.pid).toBeGreaterThan(0);
  expect(linked?.name).toBe("Agent| One");
  expect(data.panes.some((pane) => pane.project === "browser-tab-mcp")).toBe(true);
});

effectIt("built --json list exits nonzero when its tmux socket has no server", () => {
  const result = spawnSync(
    process.execPath,
    [BIN, "--json", "list", "--socket-name", `${socket}-missing`],
    { encoding: "utf8", timeout: 10_000 },
  );
  expect(result.status).toBe(1);
  expect(result.stdout).toContain("No tmux server is running");
});

effectIt("MCP text marks the snapshot as untrusted while structured names stay exact", async () => {
  const result = await callMcpTool("list", { socketName: socket });
  expect(result.isError).toBeUndefined();
  expect(result.content[0]?.type).toBe("text");
  if (result.content[0]?.type === "text") {
    expect(result.content[0].text).toMatch(/^<untrusted>\n/);
    expect(result.content[0].text).toContain("Agent| One");
  }
  const structured = result.structuredContent as { windows: { name: string }[] };
  expect(structured.windows.map((window) => window.name)).toContain("Agent| One");
});

it("missing tmux binary gives an install hint without starting a server", () => {
  const emptyPath = mkdtempSync(join(tmpdir(), "tmux-control-path-"));
  try {
    const result = spawnSync(process.execPath, [BIN, "doctor"], {
      encoding: "utf8",
      env: { ...process.env, PATH: emptyPath },
      timeout: 10_000,
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("tmux is not installed or not on PATH; install tmux and retry");
  } finally {
    rmSync(emptyPath, { recursive: true, force: true });
  }
});
