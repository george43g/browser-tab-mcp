/**
 * Signed→0-based translation (spec §5: one-based signed positions, zero-based
 * signed offsets, clamp-never-wrap) plus the snapshot lookups that feed it.
 *
 * "End" normalizes to `undefined` (append) on purpose — the extension maps it
 * to chrome.tabs.move's -1 and Safari's AppleScript pathway can ONLY append,
 * so a concrete end index would refuse a move Safari can actually do.
 */

import {
  makeBrowserState,
  makeContractTab,
  makeContractWindow,
  makeSnapshot,
} from "@george43g/test-kit";
import { describe, expect, it } from "vitest";
import { findTabLocation, findWindowTabCount, resolveSignedIndex } from "./move-resolve.js";

describe("resolveSignedIndex — absolute `to`, same-window (5 tabs)", () => {
  const w = { currentIndex: 2, sameWindow: true, destTabCount: 5 };

  it("to: 1 → index 0 (front)", () => {
    expect(resolveSignedIndex({ ...w, to: 1 })).toBe(0);
  });
  it("to: 3 → index 2", () => {
    expect(resolveSignedIndex({ ...w, to: 3 })).toBe(2);
  });
  it("to: -1 → append (end normalizes to undefined)", () => {
    expect(resolveSignedIndex({ ...w, to: -1 })).toBeUndefined();
  });
  it("to: -2 → index 3 (second-last)", () => {
    expect(resolveSignedIndex({ ...w, to: -2 })).toBe(3);
  });
  it("to: 100 clamps to the end → append", () => {
    expect(resolveSignedIndex({ ...w, to: 100 })).toBeUndefined();
  });
  it("to: -100 clamps to the front → index 0", () => {
    expect(resolveSignedIndex({ ...w, to: -100 })).toBe(0);
  });
  it("single-tab window: to: 1 is the end → append", () => {
    expect(
      resolveSignedIndex({ to: 1, currentIndex: 0, sameWindow: true, destTabCount: 1 }),
    ).toBeUndefined();
  });
});

describe("resolveSignedIndex — absolute `to`, cross-window (dest has 5 tabs, 6 slots)", () => {
  const w = { currentIndex: 0, sameWindow: false, destTabCount: 5 };

  it("to: 2 → index 1", () => {
    expect(resolveSignedIndex({ ...w, to: 2 })).toBe(1);
  });
  it("to: -1 → append", () => {
    expect(resolveSignedIndex({ ...w, to: -1 })).toBeUndefined();
  });
  it("to: -2 → index 4 (lands second-last after insertion)", () => {
    expect(resolveSignedIndex({ ...w, to: -2 })).toBe(4);
  });
  it("to: 6 is the last slot → append", () => {
    expect(resolveSignedIndex({ ...w, to: 6 })).toBeUndefined();
  });
  it("to: 7 clamps to the last slot → append", () => {
    expect(resolveSignedIndex({ ...w, to: 7 })).toBeUndefined();
  });
});

describe("resolveSignedIndex — relative `by` (5 tabs, tab at index 2)", () => {
  const w = { currentIndex: 2, sameWindow: true, destTabCount: 5 };

  it("by: -1 → index 1", () => {
    expect(resolveSignedIndex({ ...w, by: -1 })).toBe(1);
  });
  it("by: 1 → index 3", () => {
    expect(resolveSignedIndex({ ...w, by: 1 })).toBe(3);
  });
  it("by: 2 reaches the last position → append", () => {
    expect(resolveSignedIndex({ ...w, by: 2 })).toBeUndefined();
  });
  it("by: 100 clamps to the end → append (offsets clip, never wrap)", () => {
    expect(resolveSignedIndex({ ...w, by: 100 })).toBeUndefined();
  });
  it("by: -100 clamps to the front → index 0", () => {
    expect(resolveSignedIndex({ ...w, by: -100 })).toBe(0);
  });
});

describe("snapshot lookups", () => {
  const snap = makeSnapshot({
    browsers: [
      makeBrowserState({
        browser: "chrome",
        windows: [
          makeContractWindow({
            windowId: "w:chrome:x812",
            tabs: [
              makeContractTab({ tabId: "t:chrome:x101", index: 0 }),
              makeContractTab({ tabId: "t:chrome:x102", index: 1 }),
              makeContractTab({ tabId: "t:chrome:x103", index: 2 }),
            ],
          }),
          makeContractWindow({
            windowId: "w:chrome:x900",
            tabs: [makeContractTab({ tabId: "t:chrome:x201", index: 0 })],
          }),
        ],
      }),
    ],
  });

  it("findTabLocation returns window, index, and window tab count", () => {
    expect(findTabLocation(snap, "t:chrome:x102")).toEqual({
      windowId: "w:chrome:x812",
      index: 1,
      windowTabCount: 3,
    });
  });

  it("findTabLocation returns null for an unknown tab", () => {
    expect(findTabLocation(snap, "t:chrome:x999")).toBeNull();
  });

  it("findWindowTabCount counts the destination window's tabs", () => {
    expect(findWindowTabCount(snap, "w:chrome:x900")).toBe(1);
    expect(findWindowTabCount(snap, "w:chrome:x999")).toBeNull();
  });
});
