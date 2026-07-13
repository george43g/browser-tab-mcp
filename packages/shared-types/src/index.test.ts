import { describe, expect, it } from "vitest";
import {
  GetLogsInputSchema,
  HealthSnapshotSchema,
  MIRRORED_SCHEMAS,
  NoopInputSchema,
  NoopOutputSchema,
} from "./index.js";

describe("schema round-trip", () => {
  it("NoopInputSchema applies the upper default", () => {
    expect(NoopInputSchema.parse({ input: "hi" })).toEqual({ input: "hi", upper: false });
    expect(NoopInputSchema.parse({ input: "hi", upper: true })).toEqual({
      input: "hi",
      upper: true,
    });
  });

  it("NoopInputSchema rejects non-string input", () => {
    expect(NoopInputSchema.safeParse({ input: 42 }).success).toBe(false);
  });

  it("NoopOutputSchema enforces engine enum", () => {
    expect(NoopOutputSchema.parse({ echo: "x", engine: "ts", durationMicros: 1 })).toBeTruthy();
    expect(
      NoopOutputSchema.safeParse({ echo: "x", engine: "wasm", durationMicros: 1 }).success,
    ).toBe(false);
  });

  it("GetLogsInputSchema clamps tail to [1,500]", () => {
    expect(GetLogsInputSchema.parse({}).tail).toBe(50);
    expect(GetLogsInputSchema.safeParse({ tail: 0 }).success).toBe(false);
    expect(GetLogsInputSchema.safeParse({ tail: 501 }).success).toBe(false);
  });

  it("HealthSnapshotSchema rejects unknown status", () => {
    expect(HealthSnapshotSchema.safeParse({ status: "weird" }).success).toBe(false);
  });
});

describe("MIRRORED_SCHEMAS registry", () => {
  it("is a non-empty list of {tsName,rustName,fields}", () => {
    expect(MIRRORED_SCHEMAS.length).toBeGreaterThan(0);
    for (const m of MIRRORED_SCHEMAS) {
      expect(typeof m.tsName).toBe("string");
      expect(typeof m.rustName).toBe("string");
      expect(Array.isArray(m.fields)).toBe(true);
      expect(m.fields.length).toBeGreaterThan(0);
    }
  });
});
