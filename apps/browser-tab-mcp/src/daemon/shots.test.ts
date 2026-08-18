import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ShotStore } from "./shots.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bt-shots-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.BROWSER_TAB_SHOT_MAX;
});

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

describe("ShotStore", () => {
  it("miss then hit for a tab shot at the same navEpoch", () => {
    const store = new ShotStore(dir);
    expect(store.getTab("t:chrome:x1", 3)).toBeUndefined();
    const path = store.putTab("t:chrome:x1", 3, JPEG);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path)).toEqual(JPEG);
    expect(store.getTab("t:chrome:x1", 3)).toBe(path);
  });

  it("a different navEpoch is a fresh key (cache busts on navigation)", () => {
    const store = new ShotStore(dir);
    store.putTab("t:chrome:x1", 3, JPEG);
    expect(store.getTab("t:chrome:x1", 4)).toBeUndefined();
  });

  it("handle separators are made filesystem-safe", () => {
    const store = new ShotStore(dir);
    const path = store.putTab("t:chrome:x1", 0, JPEG);
    // The FILENAME is what must be safe — asserting on the whole path fails on
    // Windows for a reason that has nothing to do with the code: a drive letter
    // (`C:\Users\...`) contains the very character under test.
    expect(basename(path)).not.toContain(":");
    expect(path.endsWith(".jpg")).toBe(true);
  });

  it("window shots overwrite the same file (no epoch)", () => {
    const store = new ShotStore(dir);
    const a = store.putWindow("w:chrome:x9", JPEG);
    const b = store.putWindow("w:chrome:x9", Buffer.from([0xff, 0xd8, 0x00]));
    expect(a).toBe(b);
  });

  it("caps the shot dir at BROWSER_TAB_SHOT_MAX (LRU eviction)", () => {
    process.env.BROWSER_TAB_SHOT_MAX = "2";
    const store = new ShotStore(dir);
    store.putTab("t:chrome:x1", 1, JPEG);
    store.putTab("t:chrome:x2", 1, JPEG);
    store.putTab("t:chrome:x3", 1, JPEG);
    // Never more than max on disk (which specific one survives is mtime-ordered).
    expect(readdirSync(dir).filter((f) => f.endsWith(".jpg")).length).toBe(2);
  });
});
