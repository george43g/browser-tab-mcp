/**
 * Bookmark targeting and row coercion — the two decisions that must not be
 * made by accident.
 */

import { describe, expect, it } from "vitest";
import { resolveTarget } from "./bookmarks.js";

describe("resolveTarget", () => {
  it("infers the browser when exactly one is connected", () => {
    expect(resolveTarget(undefined, ["chrome"])).toBe("chrome");
  });

  it("REFUSES to guess when several are connected", () => {
    // Picking the first would make `remove` delete from whichever browser
    // happened to connect first — not a default anyone can reason about.
    expect(() => resolveTarget(undefined, ["chrome", "brave"])).toThrow(/pass browser/);
  });

  it("explains that bookmarks are never merged", () => {
    // `history` merges across sources because a union of visits is meaningful.
    // A merged bookmark WRITE is not, and a merged remove is destructive.
    expect(() => resolveTarget(undefined, ["chrome", "safari"])).toThrow(/never merged/);
  });

  it("names the fix when nothing is connected", () => {
    expect(() => resolveTarget(undefined, [])).toThrow(/extension-only/);
  });

  it("rejects an explicit browser that has no extension, listing what does", () => {
    // The caller asked for that source by name; silently substituting another
    // would put their bookmark somewhere they did not choose.
    expect(() => resolveTarget("safari", ["chrome"])).toThrow(/safari has no connected extension/);
    expect(() => resolveTarget("safari", ["chrome"])).toThrow(/Connected: chrome/);
  });

  it("honours an explicit browser that IS connected", () => {
    expect(resolveTarget("brave", ["chrome", "brave"])).toBe("brave");
  });
});
