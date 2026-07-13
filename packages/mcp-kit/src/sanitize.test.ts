import { describe, expect, it } from "vitest";
import { sanitize } from "./sanitize.js";

describe("sanitize", () => {
  it("returns null for null/undefined input", () => {
    expect(sanitize(null)).toBeNull();
    expect(sanitize(undefined)).toBeNull();
  });

  it("strips ANSI CSI sequences", () => {
    const input = "\x1b[31mred\x1b[0m text";
    expect(sanitize(input)).toBe("red text");
  });

  it("replaces NUL and C0 control chars with U+FFFD", () => {
    expect(sanitize("hello\x00world")).toBe("hello�world");
    expect(sanitize("a\x01b\x02c")).toBe("a�b�c");
  });

  it("preserves \\t, \\n, \\r", () => {
    expect(sanitize("a\tb\nc\rd")).toBe("a\tb\nc\rd");
  });

  it("truncates to maxLength with ellipsis", () => {
    const long = "x".repeat(5000);
    const sanitized = sanitize(long, 100);
    expect(sanitized?.length).toBe(100);
    expect(sanitized?.endsWith("…")).toBe(true);
  });

  it("default maxLength is 4096", () => {
    const long = "x".repeat(5000);
    const sanitized = sanitize(long);
    expect(sanitized?.length).toBe(4096);
  });
});
