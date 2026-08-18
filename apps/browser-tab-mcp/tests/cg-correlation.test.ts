/**
 * Integration: the real `enrichWithCgWindowIds` against a shimmed `yabai`
 * binary — covers the subprocess read, the JSON→CgWindowInfo mapping, and how
 * many times the source is consulted. The pure matching core is covered in
 * `correlate.test.ts`.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Snapshot } from "@george43g/shared-types";
import { makeBrowserState, makeContractWindow, makeSnapshot } from "@george43g/test-kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { enrichWithCgWindowIds } from "../src/detect/correlate.js";

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

const PID = 28919;
const TILED = { x: 40, y: 50, w: 1996, h: 1269 };

let dir: string;
let prevFake: string | undefined;
let prevNative: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bt-cgcorr-"));
  prevFake = process.env.BROWSER_TAB_FAKE_ADAPTER;
  prevNative = process.env.MCP_DISABLE_NATIVE;
  // Fake-adapter mode short-circuits correlation entirely; the native tier
  // would read this machine's real windows. Neither is what we're testing.
  delete process.env.BROWSER_TAB_FAKE_ADAPTER;
  process.env.MCP_DISABLE_NATIVE = "1";
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.BROWSER_TAB_YABAI_BIN;
  if (prevFake === undefined) delete process.env.BROWSER_TAB_FAKE_ADAPTER;
  else process.env.BROWSER_TAB_FAKE_ADAPTER = prevFake;
  if (prevNative === undefined) delete process.env.MCP_DISABLE_NATIVE;
  else process.env.MCP_DISABLE_NATIVE = prevNative;
});

/** A yabai shim that appends a line per invocation, then emits `rows`. */
function shimYabai(rows: unknown[], exitCode = 0): { bin: string; calls: () => number } {
  const bin = join(dir, "fake-yabai.sh");
  const log = join(dir, "calls.log");
  const payload = JSON.stringify(rows).replace(/'/g, "'\\''");
  writeFileSync(
    bin,
    `#!/bin/sh\necho call >> '${log}'\nprintf '%s' '${payload}'\nexit ${exitCode}\n`,
    { mode: 0o755 },
  );
  return {
    bin,
    calls: () => {
      try {
        return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).length;
      } catch {
        return 0;
      }
    },
  };
}

function yabaiRow(id: number, title: string) {
  return { id, pid: PID, title, frame: { ...TILED } };
}

/** Three same-frame Chrome windows — the shape a tiling WM always produces. */
function tiledSnapshot(): Snapshot {
  return makeSnapshot({
    source: "osascript-direct",
    browsers: [
      makeBrowserState({
        pid: PID,
        windows: ["Extensions", "Credits | OpenRouter", "Harness engineering | OpenAI"].map(
          (title, i) =>
            makeContractWindow({
              windowId: `w:chrome:x${i}`,
              title,
              bounds: { ...TILED },
              focused: false,
              activeTabIndex: 0,
              tabCount: 0,
              tabs: [],
            }),
        ),
      }),
    ],
  });
}

const ids = (snap: Snapshot) => snap.browsers[0]?.windows.map((w) => w.cgWindowId);

describe.skipIf(!onPosix)("enrichWithCgWindowIds (yabai tier)", () => {
  it("resolves identical-frame windows using the titles yabai reports", async () => {
    const shim = shimYabai([
      yabaiRow(542247, "Credits | OpenRouter - Google Chrome - George (Main G)"),
      yabaiRow(349035, "Extensions - Google Chrome - George (Main G)"),
      yabaiRow(382150, "Harness engineering | OpenAI - Google Chrome - George (Main G)"),
    ]);
    process.env.BROWSER_TAB_YABAI_BIN = shim.bin;
    expect(ids(await enrichWithCgWindowIds(tiledSnapshot()))).toEqual([349035, 542247, 382150]);
  });

  it("reads the source once — titles already in hand need no second spawn", async () => {
    const shim = shimYabai([
      yabaiRow(542247, "Credits | OpenRouter - Google Chrome"),
      yabaiRow(349035, "Extensions - Google Chrome"),
      yabaiRow(382150, "Harness engineering | OpenAI - Google Chrome"),
    ]);
    process.env.BROWSER_TAB_YABAI_BIN = shim.bin;
    await enrichWithCgWindowIds(tiledSnapshot());
    expect(shim.calls()).toBe(1);
  });

  it("leaves ids null when yabai reports no titles", async () => {
    const shim = shimYabai([
      { id: 542247, pid: PID, frame: { ...TILED } },
      { id: 349035, pid: PID, frame: { ...TILED } },
      { id: 382150, pid: PID, frame: { ...TILED } },
    ]);
    process.env.BROWSER_TAB_YABAI_BIN = shim.bin;
    expect(ids(await enrichWithCgWindowIds(tiledSnapshot()))).toEqual([null, null, null]);
  });

  it("returns the snapshot untouched when the source is unavailable", async () => {
    const shim = shimYabai([], 1);
    process.env.BROWSER_TAB_YABAI_BIN = shim.bin;
    const snap = tiledSnapshot();
    const out = await enrichWithCgWindowIds(snap);
    expect(ids(out)).toEqual([null, null, null]);
    expect(out.browsers[0]?.windows).toHaveLength(3);
  });

  it("skips correlation entirely under the fake adapter", async () => {
    process.env.BROWSER_TAB_FAKE_ADAPTER = "1";
    const shim = shimYabai([yabaiRow(349035, "Extensions - Google Chrome")]);
    process.env.BROWSER_TAB_YABAI_BIN = shim.bin;
    await enrichWithCgWindowIds(tiledSnapshot());
    expect(shim.calls()).toBe(0);
  });
});
