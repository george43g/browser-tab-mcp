/**
 * AnnotationStore — URL-keyed note cache (hash-normalized, 16KB/entry,
 * LRU 500, persisted to one ndjson file).
 */

import { join } from "node:path";
import { makeTmpDir } from "@george43g/test-kit";
import { describe, expect, it } from "vitest";
import { AnnotationStore } from "./annotations.js";

const path = (): string => join(makeTmpDir(), "ann.ndjson");

describe("AnnotationStore", () => {
  it("returns existed:false for an unknown url", () => {
    const r = new AnnotationStore(path()).get("https://a.com/x");
    expect(r.existed).toBe(false);
    expect(r.note).toBeUndefined();
  });

  it("sets then reads a note, ignoring the url fragment", () => {
    const s = new AnnotationStore(path());
    const set = s.set("https://a.com/x#frag", "my summary", 1000);
    expect(set.existed).toBe(false);
    expect(set.updatedAt).toBe(1000);
    const get = s.get("https://a.com/x#other");
    expect(get.existed).toBe(true);
    expect(get.note).toBe("my summary");
  });

  it("reports existed:true when overwriting", () => {
    const s = new AnnotationStore(path());
    s.set("https://a.com/x", "one", 1);
    const second = s.set("https://a.com/x", "two", 2);
    expect(second.existed).toBe(true);
    expect(s.get("https://a.com/x").note).toBe("two");
  });

  it("caps a note at 16KB", () => {
    const r = new AnnotationStore(path()).set("https://a.com/x", "z".repeat(20_000), 1);
    expect(r.note?.length).toBe(16 * 1024);
  });

  it("persists across instances (warm from disk)", () => {
    const p = path();
    new AnnotationStore(p).set("https://a.com/x", "kept", 5);
    expect(new AnnotationStore(p).get("https://a.com/x").note).toBe("kept");
  });
});
