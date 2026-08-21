#!/usr/bin/env node
/**
 * TUI stress workload — the REAL TUI, not a stand-in.
 *
 * WHAT THIS REPLACED. The previous file was the untouched starter-template
 * placeholder: it dispatched `noop` in a loop and never touched `App`,
 * `buildRows`, `useSnapshot` or the viewport helpers. It passed, every time,
 * and told you nothing about the TUI. Meanwhile the two defects that actually
 * shipped were both in the layer it skipped — rows composed from fixed slice
 * budgets that overflowed the terminal (#45), and chrome height that lied at
 * narrow widths. A harness that cannot fail on the bugs you have already had
 * is decoration.
 *
 * TWO PHASES, because the TUI has two distinct failure modes:
 *
 *   A. DATA PATH AT SCALE (no render). `buildRows` + `viewportRows` +
 *      `visibleWindow` over a large, CHURNING snapshot — tabs opening and
 *      closing, titles changing, windows folding and unfolding. This is where
 *      unbounded growth and quadratic work would show up, and it runs at a
 *      scale no fixture-based unit test does (~1500 rows by default).
 *
 *   B. RENDER PATH. The real `App`, fed by a real daemon over a real unix
 *      socket (fake adapter — no browser required), mounted under
 *      ink-testing-library, cycled through realistic terminal geometries and
 *      driven with real keystrokes. EVERY frame is checked against the two
 *      invariants the shipped bugs broke: no line wider than the terminal, no
 *      frame taller than it. A violation fails the run.
 *
 * The outer driver (`stress-tui.ts`) samples RSS / heap / event-loop p99 from
 * the watchdog state file while this runs, so memory and lag thresholds apply
 * to both phases. This file owns CORRECTNESS; the driver owns RESOURCES.
 *
 * Env:
 *   WORKLOAD_DURATION_S   total wall-clock budget      (default 60)
 *   WORKLOAD_BROWSERS     synthetic browsers in phase A (default 3)
 *   WORKLOAD_WINDOWS      windows per browser           (default 8)
 *   WORKLOAD_TABS         tabs per window               (default 60)
 *   WORKLOAD_REPORT_PATH  side-channel verdict file (optional — set by
 *                         stress-tui.ts). The exit code alone cannot carry
 *                         the correctness verdict: robustness's SIGTERM
 *                         handler hardcodes exit 0 for a clean signal death
 *                         (correct kit behavior), so a driver that force-
 *                         kills this process would read violations as a
 *                         pass. When set, this file gets the same
 *                         pass/violations verdict written reliably at the
 *                         very end of `main()`, before the process would
 *                         otherwise exit — a driver that never sees this
 *                         file written (hang, crash, forced kill) must treat
 *                         that absence as a failure, never as "no violations".
 */

import { rmSync, writeFileSync } from "node:fs";
import {
  installShutdownHandlers,
  installWatchdog,
  logStartup,
  noteActivity,
} from "@george43g/robustness";
import type { Snapshot } from "@george43g/shared-types";
import { makeTmpDir, withDaemonEnv } from "@george43g/test-kit";
import { ThemeProvider, viewportRows, visibleWindow, visualWidth } from "@george43g/tui-kit";
import { render } from "ink-testing-library";
import { type DaemonHandle, startDaemon } from "../src/daemon/index.js";
import { App } from "../src/tui/App.js";
import { buildRows } from "../src/tui/rows.js";

const DURATION_S = Number(process.env.WORKLOAD_DURATION_S ?? 60);
const BROWSERS = Number(process.env.WORKLOAD_BROWSERS ?? 3);
const WINDOWS = Number(process.env.WORKLOAD_WINDOWS ?? 8);
const TABS = Number(process.env.WORKLOAD_TABS ?? 60);
const REPORT_PATH = process.env.WORKLOAD_REPORT_PATH;

/** Strip SGR so width maths measures glyphs, not escape bytes. */
const SGR = /\x1b\[[0-9;]*m/g;
const strip = (s: string) => s.replace(SGR, "");

const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * Geometries a real user actually has. The narrow and short ones are the point
 * — 100x30 is where the frame looked fine while emitting 66 lines.
 */
const GEOMETRIES: ReadonlyArray<readonly [number, number]> = [
  [200, 60],
  [120, 40],
  [100, 30],
  [80, 24],
  [60, 20],
  [40, 12],
];

/**
 * Titles are deliberately long and emoji-bearing: short fixture strings ("Tab
 * 3") never reach the width budget, which is exactly how the overflow bug
 * survived a green suite.
 */
const TITLE_POOL = [
  "KFD 240W USB-C GaN Adapter 48V 5A NVIDIA DGX Spark 🎵",
  "fastify/fastify: Fast and low overhead web framework, for Node.js",
  "Generate Music for Any Video with AI, Instant Video to Music Matching",
  "os-fork control plane",
  "✅Claude — browser-tab-mcp — stress",
];

function makeSnapshot(seed: number): Snapshot {
  return {
    version: 2,
    generatedAt: seed,
    source: "daemon",
    focusedBrowser: "chrome",
    browsers: Array.from({ length: BROWSERS }, (_, b) => ({
      browser: (["chrome", "brave", "chromium"] as const)[b % 3],
      bundleId: "com.example",
      pid: 1000 + b,
      running: true,
      extensionConnected: b === 0,
      dataSource: b === 0 ? "extension" : "applescript",
      tabGroups: [],
      windows: Array.from({ length: WINDOWS }, (_, w) => {
        // Churn: tab COUNT varies with the seed, so rows are added and removed
        // between iterations rather than merely relabelled. A stable row count
        // would never exercise the add/remove paths.
        const count = TABS - ((seed + w) % 7);
        return {
          windowId: `w:b${b}:x${w}`,
          // Some windows fail the cgWindowId join — the wm-stack failure mode.
          cgWindowId: (w + seed) % 5 === 0 ? null : 1000 * b + w,
          title: TITLE_POOL[(w + seed) % TITLE_POOL.length],
          bounds: { x: 0, y: 0, w: 1860, h: 1020 },
          focused: w === 0,
          incognito: false,
          activeTabIndex: 0,
          state: "normal",
          tabCount: count,
          tabs: Array.from({ length: count }, (_, t) => ({
            tabId: `t:b${b}:x${w}_${t}`,
            index: t,
            url: `https://www.google.com/search?q=stress+${b}+${w}+${t}&oq=thunderbolt`,
            title: `${TITLE_POOL[(t + seed) % TITLE_POOL.length]} — ${t}`,
            active: t === 0,
            pinned: t === 1,
            audible: t % 11 === 2,
            muted: t % 11 === 2,
            discarded: t % 4 === 0,
            frozen: false,
          })),
        };
      }),
    })),
  } as unknown as Snapshot;
}

interface Violation {
  phase: string;
  detail: string;
}

const violations: Violation[] = [];
const note = (phase: string, detail: string) => {
  // Cap the log so a systemic break doesn't produce a gigabyte of output —
  // the count is what matters, the first few explain it.
  if (violations.length < 20) violations.push({ phase, detail });
};

/**
 * Phase A — data path at scale, no rendering.
 *
 * Async, and yields every `YIELD_EVERY` iterations, for a reason the first
 * version of this file got wrong: a tight SYNCHRONOUS loop starves the event
 * loop, so the watchdog's sampler never fires and the outer driver collects
 * zero samples — it then "passed" having measured nothing at all. Yielding
 * also makes this a more honest model of the TUI, which is never synchronous
 * for 30 seconds.
 */
const YIELD_EVERY = 25;

async function phaseData(deadline: number): Promise<{ iters: number; rows: number }> {
  let iters = 0;
  let rows = 0;
  const folded = new Set<string>();
  while (Date.now() < deadline) {
    iters++;
    noteActivity();
    if (iters % YIELD_EVERY === 0) await new Promise((r) => setImmediate(r));
    const snap = makeSnapshot(iters);

    // Fold churn: windows collapse and expand between iterations, which is the
    // interaction that changes row identity without changing the snapshot.
    if (iters % 3 === 0) folded.add(`w:b0:x${iters % WINDOWS}`);
    if (iters % 7 === 0) folded.clear();

    const built = buildRows(snap, folded);
    rows += built.length;

    const expectedMin = BROWSERS * (1 + WINDOWS);
    if (built.length < expectedMin) {
      note("data", `buildRows returned ${built.length} rows, expected ≥ ${expectedMin}`);
    }

    for (const [, termRows] of GEOMETRIES) {
      const viewport = viewportRows(termRows);
      // Cursor at every extreme plus one interior point — the off-by-one
      // window is at the ends, not the middle.
      for (const cursor of [0, 1, Math.floor(built.length / 2), built.length - 1]) {
        const win = visibleWindow(cursor, built.length, viewport);
        if (win.start < 0 || win.end > built.length || win.start > win.end) {
          note(
            "data",
            `visibleWindow(${cursor}, ${built.length}, ${viewport}) = ${JSON.stringify(win)}`,
          );
        }
      }
    }
  }
  return { iters, rows };
}

/** Phase B — the real App against a real daemon, every frame checked. */
async function phaseRender(deadline: number): Promise<{ frames: number }> {
  const tmp = makeTmpDir("browser-tab-stress-tui-");
  const env = withDaemonEnv(tmp, { browsers: "chrome" });
  // Scale the fake adapter UP for this phase. Its default fixture titles
  // ("Inbox (3) - Gmail") are far too short to reach a width budget, so
  // rendering them measures the fixture rather than the layout — which is
  // exactly how #45 shipped past a green suite. Verified: with these unset,
  // reintroducing that bug does NOT fail this harness; with them set, it does.
  process.env.BROWSER_TAB_FAKE_SCALE = process.env.BROWSER_TAB_FAKE_SCALE ?? "6";
  process.env.BROWSER_TAB_FAKE_TABS = process.env.BROWSER_TAB_FAKE_TABS ?? "40";
  let daemon: DaemonHandle | null = null;
  let frames = 0;
  try {
    daemon = await startDaemon();
    await daemon.loop.refresh();

    const inst = render(
      <ThemeProvider preset="safe" accent="#1982FC">
        <App />
      </ThemeProvider>,
    );
    try {
      let i = 0;
      while (Date.now() < deadline) {
        noteActivity();
        const [columns, termRows] = GEOMETRIES[i % GEOMETRIES.length] as readonly [number, number];
        // The fake stdout declares `columns` as a configurable getter and has no
        // `rows`; redefining both and emitting "resize" drives useTerminalSize
        // exactly as a real SIGWINCH does.
        Object.defineProperty(inst.stdout, "columns", { value: columns, configurable: true });
        Object.defineProperty(inst.stdout, "rows", { value: termRows, configurable: true });
        inst.stdout.emit("resize");
        await tick();

        // Drive it like a user: move, jump, fold, move back.
        for (const key of ["j", "j", "k", "G", "g", " ", "j"]) inst.stdin.write(key);
        await tick();

        const frame = inst.lastFrame() ?? "";
        frames++;
        const lines = frame.split("\n");
        if (lines.length > termRows) {
          note("render", `${columns}x${termRows}: frame emitted ${lines.length} lines`);
        }
        for (const line of lines) {
          const width = visualWidth(strip(line));
          if (width > columns) {
            note(
              "render",
              `${columns}x${termRows}: line of ${width} cols: ${strip(line).slice(0, 60)}`,
            );
            break;
          }
        }
        i++;
      }
    } finally {
      inst.unmount();
    }
  } finally {
    await daemon?.stop();
    env.restore();
    rmSync(tmp, { recursive: true, force: true });
  }
  return { frames };
}

async function main(): Promise<void> {
  installShutdownHandlers();
  installWatchdog();
  logStartup("stress-tui-workload");

  // Split the budget: the data path is cheap per iteration and benefits from
  // volume; the render path is slow per frame and benefits from time.
  const half = (DURATION_S * 1000) / 2;
  const start = Date.now();

  const data = await phaseData(start + half);
  console.log(
    `phase A · data path · ${data.iters} snapshots · ${data.rows} rows built ` +
      `(${BROWSERS}×${WINDOWS}×~${TABS})`,
  );

  const render_ = await phaseRender(start + DURATION_S * 1000);
  console.log(
    `phase B · render path · ${render_.frames} frames across ${GEOMETRIES.length} geometries`,
  );

  const pass = violations.length === 0;
  // Side-channel verdict, written reliably BEFORE this function returns (and
  // therefore before the process would otherwise exit) — see the env-doc
  // comment at the top of this file for why the exit code alone can't carry
  // this. Best-effort: a write failure here still falls through to the
  // console + exit-code reporting below, it just leaves the driver unable to
  // see the detail (which itself surfaces as a "missing report" failure).
  if (REPORT_PATH) {
    try {
      writeFileSync(
        REPORT_PATH,
        JSON.stringify(
          {
            pass,
            violations,
            frames: render_.frames,
            dataIters: data.iters,
            dataRows: data.rows,
            completedAt: Date.now(),
          },
          null,
          2,
        ),
      );
    } catch (err) {
      console.error(`failed to write workload report to ${REPORT_PATH}:`, err);
    }
  }

  if (!pass) {
    console.error(`\n${violations.length} invariant violation(s):`);
    for (const v of violations) console.error(`  [${v.phase}] ${v.detail}`);
    process.exitCode = 1;
    return;
  }
  console.log("workload completed with no invariant violations");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
