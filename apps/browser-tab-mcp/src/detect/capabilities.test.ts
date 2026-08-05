/**
 * Capability maps: the AppleScript static map, and the conservative all-false
 * default the daemon substitutes for a legacy/stale extension that connected
 * but reported no `capabilities` (so consumers always have a map to gate on).
 */

import { CAPABILITY_KEYS } from "@george43g/shared-types";
import { describe, expect, it } from "vitest";
import { applescriptCaps, conservativeCaps } from "./capabilities.js";

describe("conservativeCaps", () => {
  it("is every capability key set to false", () => {
    const caps = conservativeCaps() as Record<string, boolean>;
    expect(Object.keys(caps).sort()).toEqual([...CAPABILITY_KEYS].sort());
    expect(Object.values(caps).every((v) => v === false)).toBe(true);
  });

  it("returns a fresh object each call (no shared mutable state)", () => {
    const a = conservativeCaps() as Record<string, boolean>;
    a.navigate = true;
    expect((conservativeCaps() as Record<string, boolean>).navigate).toBe(false);
  });
});

describe("applescriptCaps", () => {
  it("enables window ops + navigation, leaves reads/grouping off", () => {
    const caps = applescriptCaps("chrome") as Record<string, boolean>;
    expect(caps.navigate).toBe(true);
    expect(caps.openWindow).toBe(true);
    expect(caps.backForward).toBe(true);
    expect(caps.tabGroups).toBe(false);
    expect(caps.contentExtraction).toBe(false);
  });

  it("has no AppleScript back/forward verb for Safari", () => {
    expect((applescriptCaps("safari") as Record<string, boolean>).backForward).toBe(false);
  });
});
