import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isMonotonicallyGrowing, _resetForTests as resetWatchdog } from "./watchdog.js";

beforeEach(() => {
  resetWatchdog();
});

afterEach(() => {
  resetWatchdog();
});

describe("isMonotonicallyGrowing", () => {
  it("returns false for fewer than 2 samples", () => {
    expect(isMonotonicallyGrowing([])).toBe(false);
    expect(isMonotonicallyGrowing([1])).toBe(false);
  });

  it("requires >= 5MB total growth", () => {
    expect(isMonotonicallyGrowing([100, 101, 102, 103, 104])).toBe(false); // <5MB total
    expect(isMonotonicallyGrowing([100, 101, 102, 103, 105])).toBe(true);
  });

  it("rejects sequences that ever decrease", () => {
    expect(isMonotonicallyGrowing([100, 102, 101, 110])).toBe(false);
  });

  it("accepts flat-then-growing sequences", () => {
    expect(isMonotonicallyGrowing([100, 100, 100, 105])).toBe(true);
  });
});
