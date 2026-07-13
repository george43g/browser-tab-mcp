import { describe, expect, it } from "vitest";
import { wrapInstructions, wrapToolError, wrapUntrusted } from "./prompt-injection.js";

describe("wrapUntrusted", () => {
  it("wraps text with untrusted markers", () => {
    const out = wrapUntrusted("dangerous content");
    expect(out).toBe("<untrusted>\ndangerous content\n</untrusted>");
  });
});

describe("wrapInstructions", () => {
  it("generates a uuid when none provided", () => {
    const out = wrapInstructions("step 1\nstep 2");
    expect(out.uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}/);
    expect(out.text).toContain(`<instructions uuid="${out.uuid}">`);
    expect(out.text).toContain("step 1\nstep 2");
  });

  it("uses caller-supplied uuid", () => {
    const out = wrapInstructions("body", "abc-123");
    expect(out.uuid).toBe("abc-123");
    expect(out.text).toContain('uuid="abc-123"');
  });
});

describe("wrapToolError", () => {
  it("formats with tool name", () => {
    expect(wrapToolError("foo", "boom")).toBe('Tool "foo" failed: boom');
  });

  it("appends hint when provided", () => {
    expect(wrapToolError("foo", "boom", "try X")).toBe('Tool "foo" failed: boom\nHint: try X');
  });
});
