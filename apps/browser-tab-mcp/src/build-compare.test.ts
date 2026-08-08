/**
 * Build-stamp comparison — the check that catches "rebuilt but never
 * reloaded", which protocol-version staleness cannot see because a stale
 * bundle of the same release speaks the same wire version.
 */

import { describe, expect, it } from "vitest";
import { commitOf, compareBuilds } from "./build-compare.js";

const CLEAN = "0.9.0+412.a1b2c3d";
const DIRTY = "0.9.0+412.a1b2c3d.dirty.0809T0706";
const DEV = "0.9.0+412.a1b2c3d.dirty.dev";
const OTHER = "0.9.0+413.9f21ab4";

describe("commitOf", () => {
  it("extracts count.sha", () => {
    expect(commitOf(CLEAN)).toBe("412.a1b2c3d");
  });

  it("ignores the dirty marker and its timestamp", () => {
    expect(commitOf(DIRTY)).toBe("412.a1b2c3d");
    expect(commitOf(DEV)).toBe("412.a1b2c3d");
  });

  it("returns null for a bare semver (pre-stamping build)", () => {
    expect(commitOf("0.2.0")).toBeNull();
  });
});

describe("compareBuilds", () => {
  it("matches artifacts from the same commit", () => {
    expect(compareBuilds(CLEAN, CLEAN)).toEqual({ kind: "match" });
  });

  it("treats a dirty build of the same commit as a match, not a mismatch", () => {
    // Flagging this would cry wolf on every dev iteration; what matters is
    // whether the two artifacts came from the same source revision.
    expect(compareBuilds(CLEAN, DIRTY)).toEqual({ kind: "match" });
  });

  it("flags a DIFFERENT commit — the rebuilt-but-not-reloaded case", () => {
    const cmp = compareBuilds(CLEAN, OTHER);
    expect(cmp.kind).toBe("mismatch");
    expect(cmp).toMatchObject({ daemon: "412.a1b2c3d", other: "413.9f21ab4" });
  });

  it("reports an unstamped counterpart rather than guessing", () => {
    expect(compareBuilds(CLEAN, "0.2.0")).toEqual({ kind: "unstamped" });
    expect(compareBuilds("0.9.0", CLEAN)).toEqual({ kind: "unstamped" });
  });
});
