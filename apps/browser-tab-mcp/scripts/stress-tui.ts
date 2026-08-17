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
 *
 * Writes `stress-tui-report.json` next to the cwd for CI artifact upload.
 */

import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const TSX = resolve(ROOT, "../../node_modules/.bin/tsx");
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

async function main(): Promise<void> {
  console.log(`stress-tui · workload ${WORKLOAD} · ${DURATION_S}s`);
  const child = spawn(TSX, [WORKLOAD], {
    env: {
      ...process.env,
      // Keep the child alive slightly LONGER than we sample, so the last
      // sample lands against a live process rather than a corpse.
      WORKLOAD_DURATION_S: process.env.WORKLOAD_DURATION_S ?? String(DURATION_S + 5),
      MCP_WATCHDOG_STATE_PATH: STATE_PATH,
      MCP_MEMORY_SAMPLE_MS: "1000",
      MCP_EVENT_LOOP_SAMPLE_MS: "1000",
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

  await new Promise<void>((resolveTimeout) => {
    setTimeout(() => resolveTimeout(), DURATION_S * 1000).unref();
  });
  clearInterval(sampler);
  child.kill("SIGTERM");
  const workloadExit = await new Promise<number>((r) => child.once("exit", (code) => r(code ?? 0)));

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
  // The workload owns CORRECTNESS (frame invariants) and signals via its exit
  // code; the driver owns RESOURCES. Neither verdict may swallow the other.
  if (workloadExit !== 0 && workloadExit !== null) {
    failures.push(`workload exited ${workloadExit} — see its invariant violations above`);
  }
  if (maxRss > RSS_FAIL_MB) failures.push(`RSS ${maxRss}MB > ${RSS_FAIL_MB}MB`);
  if (maxLag > LAG_FAIL_MS) failures.push(`event-loop p99 ${maxLag}ms > ${LAG_FAIL_MS}ms`);

  const report = {
    samples,
    maxRssMb: maxRss,
    maxLagMs: maxLag,
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
