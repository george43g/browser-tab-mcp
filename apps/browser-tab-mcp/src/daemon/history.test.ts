import type { BrowserId, CommandResult, HistoryRow } from "@george43g/shared-types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type HistoryDeps, history } from "./history.js";
import type { ExtensionServer } from "./ws-server.js";

afterEach(() => {
  delete process.env.BROWSER_TAB_SAFARI_HISTORY;
});

type SendFn = (browser: BrowserId, kind: string, args: Record<string, unknown>) => Promise<unknown>;

/** A fake ExtensionServer: `connected` lists which browsers are live. */
function makeExt(
  connected: BrowserId[],
  sendCommand: SendFn = vi.fn(async (browser: BrowserId) => ({
    payload: {
      rows: [
        { url: `https://${browser}.example/1`, title: "One", visitTime: 3000, visitCount: 2 },
        { url: `https://${browser}.example/2`, title: "Two", visitTime: 1000, visitCount: 1 },
      ],
    },
  })) as SendFn,
): { ext: ExtensionServer; sendCommand: SendFn } {
  const set = new Set(connected);
  const ext = {
    isConnected: (b: BrowserId) => set.has(b),
    sendCommand: sendCommand as unknown,
  } as unknown as ExtensionServer;
  return { ext, sendCommand };
}

const safariRows = (): HistoryRow[] => [
  {
    url: "https://safari.example/a",
    title: "A",
    visitTime: 2000,
    visitCount: 4,
    browser: "safari",
  },
];

describe("history — target resolution errors", () => {
  it("errors when an explicit browser's extension isn't connected", async () => {
    const { ext } = makeExt([]);
    await expect(history({ browser: "chrome" }, { ext })).rejects.toThrow(/extension connected/i);
  });

  it("errors when safari is requested but the flag is off", async () => {
    const { ext } = makeExt([]);
    await expect(history({ browser: "safari" }, { ext })).rejects.toThrow(
      /BROWSER_TAB_SAFARI_HISTORY/,
    );
  });
});

describe("history — chrome-family (extension) path", () => {
  it("queries the extension and tags rows with the browser", async () => {
    const { ext, sendCommand } = makeExt(["chrome"]);
    const out = await history({ browser: "chrome", query: "x", maxResults: 10 }, { ext });
    expect(sendCommand).toHaveBeenCalledWith(
      "chrome",
      "history_search",
      expect.objectContaining({ text: "x", maxResults: 10 }),
    );
    expect(out.rows.every((r) => r.browser === "chrome")).toBe(true);
    expect(out.rows[0]?.visitTime).toBe(3000); // newest first
  });
});

describe("history — safari (sqlite) path", () => {
  it("reads via the injected safari reader when enabled", async () => {
    process.env.BROWSER_TAB_SAFARI_HISTORY = "1";
    const { ext } = makeExt([]);
    const readSafari = vi.fn(async () => safariRows());
    const out = await history({ browser: "safari", maxResults: 10 }, { ext, readSafari });
    expect(readSafari).toHaveBeenCalledOnce();
    expect(out.rows).toEqual(safariRows());
  });
});

describe("history — merge across sources", () => {
  it("merges connected extensions + safari, sorts newest-first, truncates", async () => {
    process.env.BROWSER_TAB_SAFARI_HISTORY = "1";
    const { ext } = makeExt(["chrome"]);
    const readSafari = vi.fn(async () => safariRows());
    const deps: HistoryDeps = { ext, readSafari };
    const out = await history({ maxResults: 2 }, deps);
    // chrome (3000, 1000) + safari (2000) → sorted 3000, 2000, 1000 → sliced to 2.
    expect(out.rows.map((r) => r.visitTime)).toEqual([3000, 2000]);
    expect(out.rows.map((r) => r.browser)).toEqual(["chrome", "safari"]);
    expect(out.truncated).toBe(true);
  });

  it("returns an empty, non-truncated result when no source is reachable", async () => {
    const { ext, sendCommand } = makeExt([]); // nothing connected, safari off
    const out = await history({}, { ext });
    expect(out.rows).toEqual([]);
    expect(out.truncated).toBe(false);
    expect(sendCommand).not.toHaveBeenCalled();
  });
});

// The whole point of `sources`: an empty or partial merge has to say WHY,
// instead of being indistinguishable from "every source had nothing".
describe("history — per-source reporting", () => {
  it("reports every unreached source with a reason when nothing is reachable", async () => {
    const { ext } = makeExt([]);
    const out = await history({}, { ext });
    expect(out.sources.map((s) => s.browser).sort()).toEqual([
      "brave",
      "chrome",
      "chromium",
      "edge",
      "safari",
    ]);
    expect(out.sources.every((s) => s.status === "unavailable" && s.rows === 0)).toBe(true);
    const safari = out.sources.find((s) => s.browser === "safari");
    expect(safari?.source).toBe("safari-db");
    expect(safari?.reason).toMatch(/BROWSER_TAB_SAFARI_HISTORY/);
    expect(out.sources.find((s) => s.browser === "chrome")?.reason).toMatch(/not connected/);
  });

  it("marks a queried source ok with its pre-trim row count", async () => {
    const { ext } = makeExt(["chrome"]);
    const out = await history({ maxResults: 1 }, { ext });
    const chrome = out.sources.find((s) => s.browser === "chrome");
    expect(chrome).toMatchObject({ source: "extension", status: "ok", rows: 2 });
    expect(chrome?.reason).toBeUndefined();
    // rows is the source's contribution BEFORE the merge trim, not after.
    expect(out.rows).toHaveLength(1);
  });

  it("a PARTIAL merge still names the sources it skipped", async () => {
    // The regression this exists for: rows came back Chrome-only and there was
    // no way to tell whether Safari had nothing or was never asked.
    const { ext } = makeExt(["chrome"]);
    const out = await history({}, { ext });
    expect(out.rows.every((r) => r.browser === "chrome")).toBe(true);
    const byBrowser = Object.fromEntries(out.sources.map((s) => [s.browser, s.status]));
    expect(byBrowser).toEqual({
      chrome: "ok",
      chromium: "unavailable",
      brave: "unavailable",
      edge: "unavailable",
      safari: "unavailable",
    });
    expect(out.sources.find((s) => s.browser === "safari")?.reason).toMatch(
      /BROWSER_TAB_SAFARI_HISTORY/,
    );
  });

  it("a failing source becomes an error entry instead of failing the merge", async () => {
    process.env.BROWSER_TAB_SAFARI_HISTORY = "1";
    const { ext } = makeExt(["chrome"]);
    const readSafari = vi.fn(async () => {
      throw new Error("sqlite3 exited 1");
    });
    const out = await history({ maxResults: 10 }, { ext, readSafari });
    expect(out.rows.map((r) => r.browser)).toEqual(["chrome", "chrome"]);
    expect(out.sources.find((s) => s.browser === "safari")).toMatchObject({
      status: "error",
      rows: 0,
      reason: "sqlite3 exited 1",
    });
  });

  it("an EXPLICIT browser still throws rather than degrading to a partial answer", async () => {
    process.env.BROWSER_TAB_SAFARI_HISTORY = "1";
    const { ext } = makeExt([]);
    const readSafari = vi.fn(async () => {
      throw new Error("sqlite3 exited 1");
    });
    await expect(history({ browser: "safari" }, { ext, readSafari })).rejects.toThrow(
      /sqlite3 exited 1/,
    );
  });

  it("an explicit browser reports only that source, not the ones it never asked", async () => {
    const { ext } = makeExt(["chrome"]);
    const out = await history({ browser: "chrome" }, { ext });
    expect(out.sources).toEqual([
      { browser: "chrome", source: "extension", status: "ok", rows: 2 },
    ]);
  });
});

// A commandResult passthrough sanity check: the daemon coerces odd payloads.
describe("history — defensive ext-payload coercion", () => {
  it("tolerates a missing/rows-less payload", async () => {
    const send = vi.fn(async () => ({}) as CommandResult);
    const { ext } = makeExt(["chrome"], send);
    const out = await history({ browser: "chrome" }, { ext });
    expect(out.rows).toEqual([]);
    expect(out.truncated).toBe(false);
    // Queried and answered — just with nothing in it. That is `ok`, not an error.
    expect(out.sources).toEqual([
      { browser: "chrome", source: "extension", status: "ok", rows: 0 },
    ]);
  });
});
