/**
 * CLI action harness — drives the REAL commander program with argv and asserts
 * the exact payload handed to the dispatcher. The flag→tool-input glue
 * (`--no-raise` → `raiseWindow:false`, `--bounds` parsing, csv splitting,
 * number coercion, the env↔flag preAction hook) lives only in `cli.ts` action
 * closures; before this harness it was verifiable exclusively against a live
 * daemon.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isEntryPoint, main } from "./cli.js";

interface RecordedCall {
  tool: string;
  args: Record<string, unknown>;
  /** BROWSER_TAB_SOCKET_PATH as the action saw it (the preAction hook test). */
  envSocketPath: string | undefined;
}

const calls: RecordedCall[] = [];

vi.mock("./dispatcher.js", () => ({
  callMcpTool: async (tool: string, args: Record<string, unknown>) => {
    calls.push({ tool, args, envSocketPath: process.env.BROWSER_TAB_SOCKET_PATH });
    return { content: [{ type: "text", text: "{}" }], structuredContent: {}, isError: false };
  },
}));

/** Run the CLI as if invoked `browser-tab <args…>`; returns the dispatched calls. */
async function run(...args: string[]): Promise<RecordedCall[]> {
  await main(["node", "browser-tab", ...args]);
  return calls;
}

let write: { mockRestore(): void };
const savedSocketPath = process.env.BROWSER_TAB_SOCKET_PATH;
beforeEach(() => {
  calls.length = 0;
  // printResult prints every mocked result to stdout; keep test output clean.
  write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
});
afterEach(() => {
  write.mockRestore();
  if (savedSocketPath === undefined) delete process.env.BROWSER_TAB_SOCKET_PATH;
  else process.env.BROWSER_TAB_SOCKET_PATH = savedSocketPath;
});

describe("focus", () => {
  it("--no-raise maps to raiseWindow:false", async () => {
    const [call] = await run("focus", "t:chrome:x5", "--no-raise");
    expect(call).toMatchObject({
      tool: "focus_tab",
      args: { tabId: "t:chrome:x5", raiseWindow: false },
    });
  });

  it("defaults to raiseWindow:true (commander --no-* default)", async () => {
    const [call] = await run("focus", "t:chrome:x5");
    expect(call?.args).toMatchObject({ raiseWindow: true });
  });
});

describe("window set", () => {
  it("parses --bounds into a WindowBounds and carries state + focused", async () => {
    const [call] = await run(
      "window",
      "set",
      "w:chrome:x9",
      "--bounds",
      "10,20,300,400",
      "--state",
      "normal",
      "--focus",
    );
    expect(call).toMatchObject({
      tool: "set_window",
      args: {
        windowId: "w:chrome:x9",
        bounds: { x: 10, y: 20, w: 300, h: 400 },
        state: "normal",
        focused: true,
      },
    });
  });

  it("omits focused entirely when --focus is not given", async () => {
    const [call] = await run("window", "set", "w:chrome:x9", "--state", "minimized");
    expect(call?.args).not.toHaveProperty("focused");
    expect(call?.args).not.toHaveProperty("bounds");
  });

  it("rejects a malformed --bounds before dispatching anything", async () => {
    await expect(run("window", "set", "w:chrome:x9", "--bounds", "10,20,300")).rejects.toThrow(
      /four integers/,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("argument coercion", () => {
  it("open --no-activate maps to activate:false", async () => {
    const [call] = await run("open", "https://example.com", "--no-activate");
    expect(call).toMatchObject({
      tool: "open_tab",
      args: { url: "https://example.com", activate: false },
    });
  });

  it("move coerces --index to a number alongside the target window", async () => {
    const [call] = await run(
      "move",
      "t:chrome:x5",
      "--target-window",
      "w:chrome:x9",
      "--index",
      "3",
    );
    expect(call).toMatchObject({
      tool: "move_tab",
      args: { tabId: "t:chrome:x5", targetWindowId: "w:chrome:x9", targetIndex: 3 },
    });
  });

  it("group create splits and trims the --tabs csv", async () => {
    const [call] = await run(
      "group",
      "create",
      "--tabs",
      "t:chrome:x1, t:chrome:x2",
      "--title",
      "work",
    );
    expect(call).toMatchObject({
      tool: "group_tabs",
      args: { action: "create", tabIds: ["t:chrome:x1", "t:chrome:x2"], title: "work" },
    });
  });

  it("history coerces the time window and limit to numbers", async () => {
    const [call] = await run("history", "--start", "1000", "--end", "2000", "--limit", "5");
    expect(call).toMatchObject({
      tool: "history",
      args: { startTime: 1000, endTime: 2000, maxResults: 5 },
    });
  });

  it("screenshot --window sends the id as windowId, not tabId", async () => {
    const [asTab] = await run("screenshot", "t:chrome:x5");
    expect(asTab?.args).toMatchObject({ tabId: "t:chrome:x5" });
    calls.length = 0;
    const [asWindow] = await run("screenshot", "w:chrome:x9", "--window");
    expect(asWindow?.args).toMatchObject({ windowId: "w:chrome:x9" });
    expect(asWindow?.args).not.toHaveProperty("tabId");
  });

  it("list --fields core survives; anything else falls back to full", async () => {
    const [core] = await run("list", "--fields", "core");
    expect(core?.args).toMatchObject({ fields: "core" });
    calls.length = 0;
    const [full] = await run("list");
    expect(full?.args).toMatchObject({ fields: "full" });
  });
});

describe("env↔flag preAction hook", () => {
  it("--socket-path lands in process.env before the action runs", async () => {
    const [call] = await run("--socket-path", "/tmp/harness.sock", "health");
    expect(call?.tool).toBe("health_check");
    expect(call?.envSocketPath).toBe("/tmp/harness.sock");
  });
});

describe("isEntryPoint", () => {
  // THE WINDOWS BUG THIS PINS. The check was `arg.endsWith("/dist/cli.js")`.
  // On Windows `process.argv[1]` is `D:\...\dist\cli.js` — backslashes — so it
  // never matched, `main()` never ran, and `browser-tab <anything>` printed
  // nothing and exited 0. Not a degraded CLI: a SILENT one. Only the
  // windows-latest CI leg caught it, via a bundle test asserting the built bin
  // produces any output at all.
  it("matches a POSIX entry path", () => {
    expect(isEntryPoint("/Users/g/repo/apps/browser-tab-mcp/dist/cli.js")).toBe(true);
    expect(isEntryPoint("/Users/g/repo/apps/browser-tab-mcp/src/cli.ts")).toBe(true);
  });

  it("matches a WINDOWS entry path", () => {
    expect(isEntryPoint("D:\\a\\browser-tab-mcp\\apps\\browser-tab-mcp\\dist\\cli.js")).toBe(true);
    expect(isEntryPoint("C:\\tools\\browser-tab\\src\\cli.ts")).toBe(true);
  });

  it("does not match some other file that merely ends in cli.js", () => {
    // The suffix includes the directory on purpose — a dependency's own
    // `cli.js` must not make this module think it is the entry point.
    expect(isEntryPoint("/Users/g/repo/node_modules/other/cli.js")).toBe(false);
    expect(isEntryPoint("C:\\node_modules\\other\\cli.js")).toBe(false);
  });

  it("is false for an absent argv[1] rather than throwing", () => {
    expect(isEntryPoint(undefined)).toBe(false);
    expect(isEntryPoint("")).toBe(false);
  });
});

describe("empty option values are rejected, not silently dropped", () => {
  // The bug: every optional flag used `opts.x ? { k: opts.x } : {}`, which
  // cannot tell "flag absent" from "flag given an empty string". `--browser ""`
  // is falsy, so the key vanished and the query silently WIDENED to every
  // browser — a filter quietly becoming its own opposite.
  it('--browser "" fails instead of listing every browser', async () => {
    await expect(run("list", "--browser", "")).rejects.toThrow(
      /--browser was given an empty value/,
    );
    expect(calls, "nothing may reach the dispatcher").toHaveLength(0);
  });

  it('--window "" fails instead of listing every window', async () => {
    await expect(run("list", "--window", "")).rejects.toThrow(/--window/);
  });

  it("whitespace counts as empty", async () => {
    await expect(run("list", "--browser", "   ")).rejects.toThrow(/empty value/);
  });

  it("omitting the flag is still fine, and sends no key", async () => {
    const [call] = await run("list");
    expect(call?.args).not.toHaveProperty("browser");
    expect(call?.args).not.toHaveProperty("windowId");
  });

  it("a real value still passes through, trimmed", async () => {
    const [call] = await run("list", "--browser", " chrome ");
    expect(call?.args).toMatchObject({ browser: "chrome" });
  });

  it("a numeric option rejects a non-number rather than sending NaN", async () => {
    // `Number.parseInt("abc")` is NaN, which used to ride into the payload.
    await expect(run("history", "--start", "abc")).rejects.toThrow(/--start expects a number/);
  });

  it("--tabs rejects an empty entry instead of acting on fewer tabs", async () => {
    // Silently acting on two tabs when three were named is the same class of
    // quiet wrong as the empty-string case.
    await expect(run("group", "add", "--tabs", "t:chrome:x1,,t:chrome:x2")).rejects.toThrow(
      /--tabs has an empty entry/,
    );
  });

  // These two commands arrived from PRs developed in PARALLEL with this fix, so
  // they were written against the old `opts.x ? {k:x} : {}` idiom and inherited
  // the very bug this describe block exists for. `bookmark --query ""` silently
  // dropped the filter and searched EVERYTHING, which is the filter-becomes-its-
  // own-opposite failure, not a cosmetic inconsistency.
  it('bookmark --query "" fails instead of searching every bookmark', async () => {
    await expect(run("bookmark", "search", "--query", "")).rejects.toThrow(
      /--query was given an empty value/,
    );
    expect(calls, "nothing may reach the dispatcher").toHaveLength(0);
  });

  it('bookmark --browser "" fails instead of querying every browser', async () => {
    await expect(run("bookmark", "list", "--browser", "")).rejects.toThrow(/--browser/);
  });

  it('bookmark --title "" is still allowed — clearing a title is a real update', async () => {
    // The one option here where empty is a VALUE, not a mistake.
    const [call] = await run("bookmark", "update", "--id", "10", "--title", "");
    expect(call?.args).toMatchObject({ title: "" });
  });

  it("logs --tail rejects a non-number rather than sending NaN", async () => {
    await expect(run("logs", "--tail", "abc")).rejects.toThrow(/--tail expects a number/);
  });

  it("--tabs still splits and trims a well-formed list", async () => {
    const [call] = await run(
      "group",
      "add",
      "--tabs",
      "t:chrome:x1, t:chrome:x2",
      "--group",
      "g:chrome:x1",
    );
    expect(call?.args).toMatchObject({ tabIds: ["t:chrome:x1", "t:chrome:x2"] });
  });
});
