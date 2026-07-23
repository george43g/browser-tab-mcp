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
    expect(out).toEqual({ rows: [], truncated: false });
    expect(sendCommand).not.toHaveBeenCalled();
  });
});

// A commandResult passthrough sanity check: the daemon coerces odd payloads.
describe("history — defensive ext-payload coercion", () => {
  it("tolerates a missing/rows-less payload", async () => {
    const send = vi.fn(async () => ({}) as CommandResult);
    const { ext } = makeExt(["chrome"], send);
    const out = await history({ browser: "chrome" }, { ext });
    expect(out).toEqual({ rows: [], truncated: false });
  });
});
