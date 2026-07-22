/**
 * ContentCache — navEpoch/session/mode-keyed cache with file-count LRU.
 */

import { readdirSync } from "node:fs";
import { makeTmpDir } from "@george43g/test-kit";
import { afterEach, describe, expect, it } from "vitest";
import { ContentCache, type ContentKeyParts } from "./content-cache.js";

const parts = (over: Partial<ContentKeyParts> = {}): ContentKeyParts => ({
  browser: "chrome",
  handle: "t:chrome:x1",
  url: "https://a.com/",
  navEpoch: 1,
  sessionId: "s1",
  mode: "text",
  ...over,
});

describe("ContentCache", () => {
  afterEach(() => {
    delete process.env.BROWSER_TAB_CONTENT_MAX;
  });

  it("stores and retrieves by key", () => {
    const c = new ContentCache(makeTmpDir());
    expect(c.get(parts())).toBeUndefined();
    c.set(parts(), { text: "hello" });
    expect(c.get(parts())).toEqual({ text: "hello" });
  });

  it("misses when navEpoch changes (cache-bust on navigation)", () => {
    const c = new ContentCache(makeTmpDir());
    c.set(parts({ navEpoch: 1 }), { text: "v1" });
    expect(c.get(parts({ navEpoch: 2 }))).toBeUndefined();
    expect(c.get(parts({ navEpoch: 1 }))).toEqual({ text: "v1" });
  });

  it("misses when mode or sessionId differs", () => {
    const c = new ContentCache(makeTmpDir());
    c.set(parts({ mode: "text" }), { text: "t" });
    expect(c.get(parts({ mode: "state" }))).toBeUndefined();
    expect(c.get(parts({ sessionId: "s2" }))).toBeUndefined();
  });

  it("evicts down to BROWSER_TAB_CONTENT_MAX by file count", () => {
    process.env.BROWSER_TAB_CONTENT_MAX = "3";
    const dir = makeTmpDir();
    const c = new ContentCache(dir);
    for (let i = 0; i < 6; i++) c.set(parts({ handle: `t:chrome:x${i}` }), { i });
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    expect(files.length).toBeLessThanOrEqual(3);
  });
});
