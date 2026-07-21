/**
 * Enrichment single-authoring-point contract. `TabEnrichmentSchema` is the
 * ONE place the pass-through tab fields are declared; both the extension
 * mapper and the daemon mapper copy them via `pickEnrichment`. These tests
 * pin that helper's behavior so a schema change surfaces predictably.
 */

import { describe, expect, it } from "vitest";
import { pickEnrichment, TAB_ENRICHMENT_FIELDS, TabEnrichmentSchema } from "../src/index.js";

describe("TAB_ENRICHMENT_FIELDS", () => {
  it("mirrors the TabEnrichmentSchema shape exactly", () => {
    expect([...TAB_ENRICHMENT_FIELDS].sort()).toEqual(
      Object.keys(TabEnrichmentSchema.shape).sort(),
    );
  });

  it("includes the v2 additions", () => {
    for (const field of ["muted", "mutedReason", "frozen", "lastAccessed", "status"]) {
      expect(TAB_ENRICHMENT_FIELDS).toContain(field);
    }
  });
});

describe("pickEnrichment", () => {
  it("fills defaults for the boolean fields and drops unknown keys", () => {
    expect(pickEnrichment({ id: 1, url: "x", pinned: true })).toEqual({
      pinned: true,
      audible: false,
      discarded: false,
      muted: false,
      frozen: false,
    });
  });

  it("preserves provided optionals", () => {
    const out = pickEnrichment({
      pinned: false,
      audible: true,
      discarded: false,
      muted: true,
      mutedReason: "capture",
      frozen: false,
      lastAccessed: 42,
      status: "loading",
    });
    expect(out.mutedReason).toBe("capture");
    expect(out.lastAccessed).toBe(42);
    expect(out.status).toBe("loading");
  });
});
