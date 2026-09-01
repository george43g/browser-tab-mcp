import { describe, expect, it } from "vitest";
import {
  GetLogsInputSchema,
  HealthSnapshotSchema,
  MIRRORED_SCHEMAS,
  MoveTabInputSchema,
  NoopInputSchema,
  NoopOutputSchema,
  redactUrlUserinfo,
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

describe("redactUrlUserinfo", () => {
  it("strips user:pass@ and keeps the rest of the URL intact", () => {
    expect(redactUrlUserinfo("http://admin:hunter2@192.168.1.225/net?wol=sent")).toBe(
      "http://192.168.1.225/net?wol=sent",
    );
  });

  it("strips a username-only userinfo", () => {
    expect(redactUrlUserinfo("https://bob@example.com/x")).toBe("https://example.com/x");
  });

  it("leaves ordinary URLs untouched (fast path)", () => {
    expect(redactUrlUserinfo("https://example.com/a?b=c#d")).toBe("https://example.com/a?b=c#d");
  });

  it("leaves an @ that is not userinfo alone", () => {
    expect(redactUrlUserinfo("https://example.com/@profile")).toBe("https://example.com/@profile");
  });

  it("returns unparseable input unchanged rather than throwing", () => {
    expect(redactUrlUserinfo("not a url @ all")).toBe("not a url @ all");
  });
});

describe("MoveTabInputSchema signed forms", () => {
  const base = { tabId: "t:chrome:x101" };

  it("accepts to/by alone and the legacy targetIndex form", () => {
    expect(MoveTabInputSchema.safeParse({ ...base, to: -1 }).success).toBe(true);
    expect(MoveTabInputSchema.safeParse({ ...base, by: -3 }).success).toBe(true);
    expect(
      MoveTabInputSchema.safeParse({ ...base, targetWindowId: "w:chrome:x8", targetIndex: 0 })
        .success,
    ).toBe(true);
    expect(
      MoveTabInputSchema.safeParse({ ...base, targetWindowId: "w:chrome:x8", to: 2 }).success,
    ).toBe(true);
  });

  it("rejects to: 0 and by: 0 with field-specific messages", () => {
    const to0 = MoveTabInputSchema.safeParse({ ...base, to: 0 });
    expect(to0.success).toBe(false);
    if (!to0.success) expect(JSON.stringify(to0.error.issues)).toMatch(/one-based/);
    expect(MoveTabInputSchema.safeParse({ ...base, by: 0 }).success).toBe(false);
  });

  it("rejects combining two positional spellings", () => {
    expect(MoveTabInputSchema.safeParse({ ...base, to: 1, by: 1 }).success).toBe(false);
    expect(MoveTabInputSchema.safeParse({ ...base, targetIndex: 0, to: 1 }).success).toBe(false);
    expect(MoveTabInputSchema.safeParse({ ...base, targetIndex: 0, by: 1 }).success).toBe(false);
  });

  it("rejects by with a destination (same-window by definition)", () => {
    expect(
      MoveTabInputSchema.safeParse({ ...base, by: 1, targetWindowId: "w:chrome:x8" }).success,
    ).toBe(false);
    expect(MoveTabInputSchema.safeParse({ ...base, by: 1, newWindow: true }).success).toBe(false);
  });

  it("rejects to into a new window", () => {
    expect(MoveTabInputSchema.safeParse({ ...base, to: 1, newWindow: true }).success).toBe(false);
  });

  it("still rejects a negative legacy targetIndex", () => {
    expect(
      MoveTabInputSchema.safeParse({ ...base, targetWindowId: "w:chrome:x8", targetIndex: -1 })
        .success,
    ).toBe(false);
  });
});
