import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildHistorySql,
  COCOA_EPOCH_OFFSET_S,
  cocoaToUnixMs,
  readSafariHistory,
  safariHistoryEnabled,
  unixMsToCocoa,
} from "./safari-history.js";

/**
 * WINDOWS: skipped, deliberately.
 *
 * This suite shims a macOS-only binary with a `#!/bin/sh` script, which Windows
 * cannot execute (`spawn EFTYPE`). Making the shim portable would mean teaching
 * the production code to accept an interpreter plus arguments rather than a
 * binary path — real complexity added to ship a fixture.
 *
 * The subsystem under test is macOS-only anyway. The windows-latest CI leg
 * exists to prove the DAEMON builds and runs there, not to re-test features
 * that platform does not have.
 */
const onPosix = process.platform !== "win32";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bt-safari-hist-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.BROWSER_TAB_SAFARI_HISTORY;
  delete process.env.BROWSER_TAB_SQLITE_BIN;
  delete process.env.BROWSER_TAB_SAFARI_HISTORY_DB;
});

describe("Cocoa epoch conversion", () => {
  it("cocoaToUnixMs adds the 2001→1970 offset and scales to ms", () => {
    // Cocoa second 0 == 2001-01-01T00:00:00Z == 978307200 unix seconds.
    expect(cocoaToUnixMs(0)).toBe(COCOA_EPOCH_OFFSET_S * 1000);
    expect(cocoaToUnixMs(700_000_000)).toBe((700_000_000 + COCOA_EPOCH_OFFSET_S) * 1000);
  });

  it("unixMsToCocoa is the inverse of cocoaToUnixMs", () => {
    const cocoa = 700_000_123;
    expect(unixMsToCocoa(cocoaToUnixMs(cocoa))).toBeCloseTo(cocoa, 3);
  });
});

describe("buildHistorySql", () => {
  it("interpolates only integer bounds — no text ever reaches the SQL", () => {
    const sql = buildHistorySql({ startCocoa: 100.9, endCocoa: 200.1, limit: 25 });
    // Truncated to integers, not the fractional inputs.
    expect(sql).toContain("hv.visit_time >= 100");
    expect(sql).toContain("hv.visit_time <= 200");
    expect(sql).toContain("LIMIT 25");
    expect(sql).toContain("GROUP BY hi.id");
    // Whole statement is just the SELECT — no injected string fragments.
    expect(sql).toMatch(/^SELECT .* LIMIT 25;$/s);
  });

  it("omits bounds that are null and always emits a valid LIMIT", () => {
    const sql = buildHistorySql({ startCocoa: null, endCocoa: null, limit: 5 });
    expect(sql).not.toContain("WHERE");
    expect(sql).toContain("LIMIT 5");
  });

  it("floors the limit at 1 and rejects non-finite bounds", () => {
    expect(buildHistorySql({ startCocoa: null, endCocoa: null, limit: 0 })).toContain("LIMIT 1");
    expect(() => buildHistorySql({ startCocoa: Number.NaN, endCocoa: null, limit: 5 })).toThrow(
      /non-finite/,
    );
  });
});

describe("safariHistoryEnabled", () => {
  it("is off by default and on when the env flag is set", () => {
    expect(safariHistoryEnabled()).toBe(false);
    process.env.BROWSER_TAB_SAFARI_HISTORY = "1";
    expect(safariHistoryEnabled()).toBe(true);
  });
});

/** A fake `sqlite3` that ignores its args and prints a fixed JSON rows array. */
function shimSqlite(json: string): string {
  const bin = join(dir, "fake-sqlite3.sh");
  writeFileSync(bin, `#!/bin/sh\ncat <<'JSONEOF'\n${json}\nJSONEOF\n`, { mode: 0o755 });
  return bin;
}

describe.skipIf(!onPosix)("readSafariHistory (shimmed sqlite3)", () => {
  function seedDb(): string {
    const db = join(dir, "History.db");
    writeFileSync(db, "not-a-real-db"); // only needs to exist for the copy
    process.env.BROWSER_TAB_SAFARI_HISTORY_DB = db;
    return db;
  }

  it("maps rows, converts Cocoa times, and tags browser:safari", async () => {
    seedDb();
    process.env.BROWSER_TAB_SQLITE_BIN = shimSqlite(
      JSON.stringify([
        { url: "https://a.com", title: "Alpha", visit_time: 700000100, visit_count: 3 },
        { url: "https://b.com", title: null, visit_time: 700000000, visit_count: 1 },
      ]),
    );
    const rows = await readSafariHistory({ maxResults: 10 });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      url: "https://a.com",
      title: "Alpha",
      visitCount: 3,
      browser: "safari",
      visitTime: cocoaToUnixMs(700000100),
    });
    // NULL title becomes an absent field, not the string "null".
    expect(rows[1]?.title).toBeUndefined();
  });

  it("applies the text filter in TS and slices to maxResults", async () => {
    seedDb();
    process.env.BROWSER_TAB_SQLITE_BIN = shimSqlite(
      JSON.stringify([
        { url: "https://news.example", title: "Headlines", visit_time: 700000200, visit_count: 2 },
        { url: "https://shop.example", title: "Cart", visit_time: 700000100, visit_count: 5 },
        { url: "https://news.other", title: "More news", visit_time: 700000000, visit_count: 1 },
      ]),
    );
    const rows = await readSafariHistory({ query: "news", maxResults: 10 });
    expect(rows.map((r) => r.url)).toEqual(["https://news.example", "https://news.other"]);

    const capped = await readSafariHistory({ query: "news", maxResults: 1 });
    expect(capped).toHaveLength(1);
  });

  it("returns [] when sqlite emits no rows (empty stdout)", async () => {
    seedDb();
    process.env.BROWSER_TAB_SQLITE_BIN = shimSqlite("");
    expect(await readSafariHistory({ maxResults: 10 })).toEqual([]);
  });

  it("throws an FDA-flavored hint when History.db can't be copied", async () => {
    process.env.BROWSER_TAB_SAFARI_HISTORY_DB = join(dir, "does-not-exist.db");
    process.env.BROWSER_TAB_SQLITE_BIN = shimSqlite("[]");
    await expect(readSafariHistory({ maxResults: 10 })).rejects.toThrow(/Full Disk Access/i);
  });
});

// Real end-to-end SQL coverage when a sqlite3 binary is available (always on
// macOS; skipped where it isn't, e.g. a bare Linux CI image).
const SQLITE = "/usr/bin/sqlite3";
const hasSqlite = existsSync(SQLITE);

describe.skipIf(!hasSqlite)("readSafariHistory (real sqlite3)", () => {
  function realDb(): string {
    const db = join(dir, "History.db");
    const schema = [
      "CREATE TABLE history_items (id INTEGER PRIMARY KEY, url TEXT);",
      "CREATE TABLE history_visits (id INTEGER PRIMARY KEY, history_item INTEGER, visit_time REAL, title TEXT);",
      "INSERT INTO history_items (id, url) VALUES (1,'https://example.com'),(2,'https://news.site');",
      "INSERT INTO history_visits (id, history_item, visit_time, title) VALUES " +
        "(1,1,700000000.5,'Example'),(2,1,700000100.0,'Example Again'),(3,2,690000000.0,'News');",
    ].join("\n");
    execFileSync(SQLITE, [db, schema]);
    process.env.BROWSER_TAB_SAFARI_HISTORY_DB = db;
    return db;
  }

  it("aggregates visits per url, newest first, Cocoa-converted", async () => {
    realDb();
    const rows = await readSafariHistory({ maxResults: 10 });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      url: "https://example.com",
      visitCount: 2,
      title: "Example Again", // bare column follows the MAX(visit_time) row
      browser: "safari",
      visitTime: cocoaToUnixMs(700000100),
    });
    expect(rows[1]?.url).toBe("https://news.site");
  });

  it("post-filters by query against the real rows", async () => {
    realDb();
    const rows = await readSafariHistory({ query: "news", maxResults: 10 });
    expect(rows.map((r) => r.url)).toEqual(["https://news.site"]);
  });
});
