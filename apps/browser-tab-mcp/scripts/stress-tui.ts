#!/usr/bin/env node
/**
 * TUI stress harness — runs the headless workload and externally samples
 * RSS / CPU / event-loop p99 via the watchdog's state file.
 *
 * The starter template ships a placeholder workload that scrolls through
 * a synthetic list — real tools should replace `stress-tui-workload.ts`
 * with their domain's hottest data path (e.g. lazy-loading 250k messages
 * across 1200 chats for imsg-mcp).
 *
 * Run: `pnpm stress:tui`
 *
 * Thresholds (env-overridable):
 *   STRESS_RSS_FAIL_MB     fail if RSS exceeds this (default 800)
 *   STRESS_LAG_FAIL_MS     fail if event-loop p99 exceeds this (default 2000)
 *   STRESS_DURATION_S      total sample duration (default 30)
 *   STRESS_GRACE_MS        hang-protection margin past the workload's own
 *                          internal deadline before SIGTERM (default 10000)
 *
 * Writes `stress-tui-report.json` next to the cwd for CI artifact upload.
 *
 * VERDICT PLUMBING — two independent verdicts, and neither may swallow the
 * other (this file owns RESOURCES, the workload owns CORRECTNESS). This used
 * to be broken: the driver SIGTERM'd the workload at STRESS_DURATION_S
 * (30s) while the workload's own internal budget ran to STRESS_DURATION_S+5
 * (35s) before it ever reached the code that checks `violations` and sets an
 * exit code — so the workload was ALWAYS killed mid-flight, and
 * `@george43g/robustness`'s SIGTERM handler hardcodes exit 0 for SIGTERM
 * (`shutdown(received === "SIGINT" ? 130 : 0)` — correct kit behavior, a
 * clean-signal death should not look like a crash). Net effect: the exit
 * code could NEVER carry a correctness verdict; a real sabotaged frame
 * still exited 0. Fixed on two axes:
 *   1. SIGTERM is hang-protection only. The workload gets its FULL internal
 *      deadline (WORKLOAD_DURATION_S) plus STRESS_GRACE_MS before any signal
 *      — the driver waits on the child's own `exit` event, not a fixed timer.
 *      A workload still alive past that point is genuinely hung, and getting
 *      killed for it is correctly reported as a FAILURE, never a pass.
 *   2. The correctness verdict is read from a side-channel report file the
 *      workload writes (WORKLOAD_REPORT_PATH), not the exit code — mirrors
 *      the existing watchdog-state-file pattern below. A missing or
 *      unreadable report (crash, hang-kill, anything that skips the
 *      workload's own end-of-run write) is a FAILURE by construction: a
 *      missing report can never be read as "no violations", same as a phone
 *      that didn't ring is not news of nothing wrong.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
/**
 * Load tsx into node itself instead of spawning the `.bin/tsx` shim — see the
 * full rationale in stress-mcp.ts. Beyond the Windows shim breakage documented
 * there, the shim is a SIGNAL RELAY with a ~30ms IPC ack window: a workload
 * busy enough to miss the ack gets SIGKILL, which tsx reports as exit 143 —
 * and this driver reads that exit code as a verdict (line ~102). The heavy-
 * scale soak failed on exactly that. Direct spawn = the signal lands on the
 * workload itself, and a clean SIGTERM death maps to code null, not 143.
 */
const NODE = process.execPath;
const TSX_ARGS = ["--import", "tsx"];
const WORKLOAD = resolve(__dirname, "stress-tui-workload.tsx");

const RSS_FAIL_MB = Number(process.env.STRESS_RSS_FAIL_MB ?? 800);
const LAG_FAIL_MS = Number(process.env.STRESS_LAG_FAIL_MS ?? 2000);
const DURATION_S = Number(process.env.STRESS_DURATION_S ?? 30);
const STATE_PATH = join(tmpdir(), `watchdog-state-${process.pid}.json`);

interface Sample {
  ts: number;
  rssMb: number;
  heapMb: number;
  eventLoopP99Ms: number;
}

/** Mirrors the verdict shape stress-tui-workload.tsx writes to WORKLOAD_REPORT_PATH. */
interface WorkloadReport {
  pass: boolean;
  violations: Array<{ phase: string; detail: string }>;
  frames?: number;
  dataIters?: number;
  dataRows?: number;
  completedAt?: number;
}

const GRACE_MS = Number(process.env.STRESS_GRACE_MS ?? 10_000);

async function main(): Promise<void> {
  console.log(`stress-tui · workload ${WORKLOAD} · ${DURATION_S}s`);
  const workloadDurationS = Number(process.env.WORKLOAD_DURATION_S ?? DURATION_S);
  const reportPath = join(tmpdir(), `stress-tui-workload-report-${process.pid}.json`);
  const child = spawn(NODE, [...TSX_ARGS, WORKLOAD], {
    env: {
      ...process.env,
      WORKLOAD_DURATION_S: String(workloadDurationS),
      MCP_WATCHDOG_STATE_PATH: STATE_PATH,
      MCP_MEMORY_SAMPLE_MS: "1000",
      MCP_EVENT_LOOP_SAMPLE_MS: "1000",
      // Side-channel correctness verdict — see the big comment block above.
      WORKLOAD_REPORT_PATH: reportPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const samples: Sample[] = [];
  const sampler = setInterval(() => {
    if (!existsSync(STATE_PATH)) return;
    try {
      const state = JSON.parse(readFileSync(STATE_PATH, "utf8")) as {
        rssMb: number;
        heapMb: number;
        eventLoopP99Ms: number;
      };
      samples.push({
        ts: Date.now(),
        rssMb: state.rssMb,
        heapMb: state.heapMb,
        eventLoopP99Ms: state.eventLoopP99Ms,
      });
    } catch {
      // ignore
    }
  }, 1000);

  // SIGTERM is hang-protection only, fired ONLY if the workload is still
  // alive after its own full internal deadline plus a grace margin — never
  // as a substitute for waiting out the run. A workload that dies here never
  // reached its own verdict-writing code, so this is unconditionally a FAILURE
  // (see `hung` below), not a race the driver could still pass.
  let hung = false;
  const hangTimer = setTimeout(
    () => {
      hung = true;
      child.kill("SIGTERM");
    },
    workloadDurationS * 1000 + GRACE_MS,
  );
  hangTimer.unref();

  const workloadExit = await new Promise<number | null>((r) =>
    child.once("exit", (code) => r(code)),
  );
  clearTimeout(hangTimer);
  clearInterval(sampler);

  const maxRss = samples.reduce((m, s) => Math.max(m, s.rssMb), 0);
  const maxLag = samples.reduce((m, s) => Math.max(m, s.eventLoopP99Ms), 0);
  const failures: string[] = [];
  // ZERO SAMPLES IS A FAILURE, not a clean run. This harness reported
  // "max RSS 0MB, max lag 0ms, 0 samples" and exited 0 — passing while
  // measuring nothing, which is the exact complaint that got it rewritten.
  // (Root cause then: the workload's hot loop was synchronous, so the
  // watchdog's timer never fired and the state file was never written.)
  if (samples.length === 0) {
    failures.push(
      `no watchdog samples collected — the workload never wrote ${STATE_PATH}. ` +
        "Either it died early or it starved the event loop.",
    );
  }

  // Correctness verdict comes from the workload's OWN report file, never the
  // exit code — robustness's SIGTERM handler hardcodes exit 0, so exit code
  // alone cannot distinguish "clean pass" from "killed before it could say".
  let workloadReport: WorkloadReport | null = null;
  if (existsSync(reportPath)) {
    try {
      workloadReport = JSON.parse(readFileSync(reportPath, "utf8")) as WorkloadReport;
    } catch (err) {
      failures.push(
        `workload report at ${reportPath} is unreadable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  if (hung) {
    failures.push(
      `workload did not complete within its internal deadline (${workloadDurationS}s) + ` +
        `${GRACE_MS}ms grace — killed as a hang; a forced kill is never a pass`,
    );
  } else if (!workloadReport) {
    failures.push(
      `workload exited (code ${workloadExit ?? "signal"}) without writing a verdict report at ` +
        `${reportPath} — a missing report is never a pass`,
    );
  } else if (!workloadReport.pass) {
    failures.push(`workload reported ${workloadReport.violations.length} invariant violation(s):`);
    for (const v of workloadReport.violations ?? []) failures.push(`  [${v.phase}] ${v.detail}`);
  }
  // Defense-in-depth: the report-file verdict above stays primary, but a
  // workload that wrote pass:true and then died non-zero for an unrelated
  // reason (a teardown rejection, an async watchdog kill after main()
  // returned) must not read as a clean PASS with the exit code buried in an
  // unused JSON field. Soft check, same shape the old exit-code-as-verdict
  // logic had — just no longer the ONLY signal.
  if (!hung && workloadExit !== 0 && workloadExit !== null) {
    failures.push(`workload exited ${workloadExit} despite reporting pass — investigate`);
  }

  if (maxRss > RSS_FAIL_MB) failures.push(`RSS ${maxRss}MB > ${RSS_FAIL_MB}MB`);
  if (maxLag > LAG_FAIL_MS) failures.push(`event-loop p99 ${maxLag}ms > ${LAG_FAIL_MS}ms`);

  const report = {
    samples,
    maxRssMb: maxRss,
    maxLagMs: maxLag,
    workloadExitCode: workloadExit,
    workloadHung: hung,
    workloadReport,
    failures,
    pass: failures.length === 0,
  };
  writeFileSync(resolve(ROOT, "stress-tui-report.json"), JSON.stringify(report, null, 2));
  console.log(`max RSS ${maxRss}MB, max lag ${maxLag}ms, ${samples.length} samples`);
  for (const f of failures) console.log(`::error::${f}`);
  process.exit(report.pass ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
