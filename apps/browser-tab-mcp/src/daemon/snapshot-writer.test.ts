/**
 * SnapshotWriter — the file surface shell consumers read instead of opening
 * the socket. Two files with deliberately different meanings:
 *
 *   snapshot.json   rewritten ONLY on a diff — its mtime means "state changed"
 *   heartbeat.json  rewritten every completed tick — its mtime means "alive"
 *
 * Collapsing those into one file is the mistake these tests exist to prevent:
 * a bar renderer needs to tell "nothing changed" apart from "daemon died", and
 * a single mtime cannot say both.
 */

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeSnapshot } from "@george43g/test-kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SnapshotWriter } from "./snapshot-writer.js";

let tmp: string;
let prevCacheDir: string | undefined;
let prevSnapshotPath: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "bt-writer-"));
  prevCacheDir = process.env.BROWSER_TAB_CACHE_DIR;
  prevSnapshotPath = process.env.BROWSER_TAB_SNAPSHOT_PATH;
  process.env.BROWSER_TAB_CACHE_DIR = tmp;
  process.env.BROWSER_TAB_SNAPSHOT_PATH = join(tmp, "snapshot.json");
});

afterEach(() => {
  if (prevCacheDir === undefined) delete process.env.BROWSER_TAB_CACHE_DIR;
  else process.env.BROWSER_TAB_CACHE_DIR = prevCacheDir;
  if (prevSnapshotPath === undefined) delete process.env.BROWSER_TAB_SNAPSHOT_PATH;
  else process.env.BROWSER_TAB_SNAPSHOT_PATH = prevSnapshotPath;
});

const heartbeat = (): Record<string, unknown> =>
  JSON.parse(readFileSync(join(tmp, "heartbeat.json"), "utf8"));

describe("SnapshotWriter.heartbeat", () => {
  it("writes a beacon a shell consumer can stat and read", () => {
    const writer = new SnapshotWriter(() => 0);
    writer.heartbeat();

    const hb = heartbeat();
    expect(hb.pid).toBe(process.pid);
    expect(hb.contractVersion).toBe(2);
    expect(typeof hb.build).toBe("string");
    expect(typeof hb.ts).toBe("number");
  });

  it("refreshes on every call — this is the liveness signal", () => {
    const writer = new SnapshotWriter(() => 0);
    writer.heartbeat();
    const first = heartbeat().ts as number;
    // Beat again against a ts that has definitely moved.
    const spin = Date.now();
    while (Date.now() === spin) {
      /* wait out the millisecond */
    }
    writer.heartbeat();
    expect(heartbeat().ts as number).toBeGreaterThan(first);
  });

  it("carries snapshotChangedAt so one read separates 'alive' from 'current'", () => {
    // The whole point: snapshot.json is only rewritten on a diff, so its own
    // mtime can be hours old AND correct. The beacon dates that separately.
    const writer = new SnapshotWriter(() => 0);
    writer.heartbeat();
    expect(heartbeat().snapshotChangedAt).toBe(0); // nothing written yet

    writer.schedule(makeSnapshot({}));
    writer.flush();
    writer.heartbeat();
    expect(heartbeat().snapshotChangedAt as number).toBeGreaterThan(0);
  });

  it("does not touch snapshot.json — its mtime must keep meaning 'state changed'", () => {
    const writer = new SnapshotWriter(() => 0);
    writer.heartbeat();
    expect(existsSync(join(tmp, "snapshot.json"))).toBe(false);
  });

  it("leaves no .tmp behind (atomic rename)", () => {
    const writer = new SnapshotWriter(() => 0);
    writer.heartbeat();
    expect(existsSync(join(tmp, "heartbeat.json.tmp"))).toBe(false);
  });

  it("removes the beacon on a clean stop, so a stopped daemon reads as down", () => {
    const writer = new SnapshotWriter(() => 0);
    writer.heartbeat();
    expect(existsSync(join(tmp, "heartbeat.json"))).toBe(true);

    writer.stop();
    expect(existsSync(join(tmp, "heartbeat.json"))).toBe(false);
  });

  it("stop() is safe when no beacon was ever written", () => {
    const writer = new SnapshotWriter(() => 0);
    expect(() => writer.stop()).not.toThrow();
  });
});
