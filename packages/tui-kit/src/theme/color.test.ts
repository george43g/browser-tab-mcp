import { describe, expect, it } from "vitest";
import { contrastRatio, hexToHsl, hslToHex, withL, withS } from "./color.js";

describe("color round-trip", () => {
  it("hex → hsl → hex is approximately identity", () => {
    for (const hex of ["#1982fc", "#ff0000", "#00ff00", "#0000ff", "#808080"]) {
      const back = hslToHex(hexToHsl(hex));
      expect(back).toBe(hex);
    }
  });

  it("throws on bad hex", () => {
    expect(() => hexToHsl("not-a-color")).toThrow();
    expect(() => hexToHsl("#ABC")).toThrow();
  });

  it("withL clamps to [0,1]", () => {
    expect(hexToHsl(withL("#1982fc", 1.5)).l).toBe(1);
    expect(hexToHsl(withL("#1982fc", -0.5)).l).toBe(0);
  });

  it("withS=0 produces grey", () => {
    const grey = withS("#1982fc", 0);
    expect(hexToHsl(grey).s).toBeCloseTo(0, 5);
  });
});

describe("contrastRatio", () => {
  it("returns 21 for black vs white (WCAG ceiling)", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
  });

  it("returns 1 for identical colors", () => {
    expect(contrastRatio("#abcdef", "#abcdef")).toBe(1);
  });

  it("is symmetric", () => {
    const a = contrastRatio("#1982fc", "#111111");
    const b = contrastRatio("#111111", "#1982fc");
    expect(a).toBe(b);
  });
});
