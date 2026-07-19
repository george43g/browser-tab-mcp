/**
 * Parser + id-scheme unit tests for the detect layer. Pure fixtures — no
 * osascript, no browsers.
 */

import { describe, expect, it } from "vitest";
import {
  makeChromiumTabId,
  makeSafariTabId,
  makeWindowId,
  parseTabId,
  parseWindowId,
} from "../src/detect/ids.js";
import { parseRecordOutput, RS } from "../src/detect/parse.js";

function w(fields: (string | number)[]): string {
  return ["W", ...fields].join(RS);
}
function t(fields: (string | number)[]): string {
  return ["T", ...fields].join(RS);
}

describe("parseRecordOutput", () => {
  it("parses windows with bounds, active index, mode and tabs", () => {
    const raw = [
      `A${RS}true`,
      w([812, 0, 25, 1440, 900, 2, "normal", "Inbox - Gmail"]),
      t([9931, "https://mail.google.com/", "Inbox"]),
      t([9932, "https://github.com/", "GitHub"]),
      w([813, 100, 50, 800, 650, 1, "incognito", "Private"]),
      t([9940, "https://example.com/", "Example"]),
      "",
    ].join("\n");

    const windows = parseRecordOutput(raw);
    expect(windows).toHaveLength(2);
    expect(windows[0]).toMatchObject({
      nativeId: "812",
      activeTabIndex1: 2,
      mode: "normal",
      title: "Inbox - Gmail",
      bounds: { x: 0, y: 25, w: 1440, h: 875 },
    });
    expect(windows[0]?.tabs).toHaveLength(2);
    expect(windows[0]?.tabs[1]).toMatchObject({
      nativeId: "9932",
      url: "https://github.com/",
      title: "GitHub",
    });
    expect(windows[1]?.mode).toBe("incognito");
    expect(windows[1]?.tabs).toHaveLength(1);
  });

  it("treats a non-record line as a title continuation (embedded linefeed)", () => {
    const raw = [
      w([1, 0, 0, 100, 100, 1, "normal", "First line"]),
      t([7, "https://x.test/", "Title with"]),
      "an embedded newline",
      t([8, "https://y.test/", "Next tab"]),
    ].join("\n");

    const windows = parseRecordOutput(raw);
    expect(windows[0]?.tabs[0]?.title).toBe("Title with an embedded newline");
    expect(windows[0]?.tabs[1]?.title).toBe("Next tab");
  });

  it("handles quotes, backslashes and unicode in titles/urls", () => {
    const nasty = String.raw`He said "hi" \ ☂ émoji`;
    const raw = [
      w([5, 0, 0, 10, 10, 1, "normal", nasty]),
      t([6, "https://z.test/?q=%22", nasty]),
    ].join("\n");
    const windows = parseRecordOutput(raw);
    expect(windows[0]?.title).toBe(nasty);
    expect(windows[0]?.tabs[0]?.title).toBe(nasty);
  });

  it("returns [] for empty or garbage input", () => {
    expect(parseRecordOutput("")).toEqual([]);
    expect(parseRecordOutput("complete nonsense\nno records here")).toEqual([]);
  });

  it("drops tab records that appear before any window", () => {
    const raw = [
      t([1, "https://orphan.test/", "Orphan"]),
      w([2, 0, 0, 10, 10, 1, "normal", "W"]),
    ].join("\n");
    const windows = parseRecordOutput(raw);
    expect(windows).toHaveLength(1);
    expect(windows[0]?.tabs).toHaveLength(0);
  });

  it("nulls bounds when coordinates are malformed", () => {
    const raw = w([3, "x", "y", "z", "w", 1, "normal", "Bad bounds"]);
    expect(parseRecordOutput(raw)[0]?.bounds).toBeNull();
  });
});

describe("opaque ids", () => {
  it("round-trips chromium tab ids", () => {
    const id = makeChromiumTabId("chrome", 9931);
    expect(parseTabId(id)).toEqual({ browser: "chrome", nativeId: "9931", ext: false });
  });

  it("round-trips safari synthetic tab ids", () => {
    const id = makeSafariTabId(812, 3);
    expect(parseTabId(id)).toEqual({
      browser: "safari",
      ext: false,
      safari: { nativeWindowId: "812", index1: 3 },
    });
  });

  it("round-trips window ids", () => {
    expect(parseWindowId(makeWindowId("brave", 42))).toEqual({
      browser: "brave",
      nativeId: "42",
      ext: false,
    });
  });

  it("round-trips extension-generation ids", async () => {
    const { makeExtTabId, makeExtWindowId } = await import("../src/detect/ids.js");
    expect(parseTabId(makeExtTabId("chrome", 4001))).toEqual({
      browser: "chrome",
      nativeId: "4001",
      ext: true,
    });
    expect(parseWindowId(makeExtWindowId("safari", 9))).toEqual({
      browser: "safari",
      nativeId: "9",
      ext: true,
    });
  });

  it("rejects bare numeric safari tab ids (only synthetic or ext forms exist)", () => {
    expect(parseTabId("t:safari:12")).toBeNull();
  });

  it("rejects malformed / injection-shaped ids", () => {
    expect(parseTabId('t:chrome:9931" then activate')).toBeNull();
    expect(parseTabId("t:chrome:")).toBeNull();
    expect(parseTabId("t:netscape:1")).toBeNull();
    expect(parseWindowId("w:chrome:12abc")).toBeNull();
    expect(parseWindowId("")).toBeNull();
  });
});
