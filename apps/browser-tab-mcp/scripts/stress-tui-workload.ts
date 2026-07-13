#!/usr/bin/env node
/**
 * Headless TUI workload — runs the same data path the TUI exercises but
 * without Ink rendering (Ink requires a TTY raw mode that CI pipes break).
 *
 * For the starter, this is a synthetic placeholder: dispatch noop in a
 * tight loop with backpressure. Real tools replace this with their
 * domain's hottest read path (e.g. listConversations → getMessages →
 * paginate × N).
 */

import {
  installShutdownHandlers,
  installWatchdog,
  logStartup,
  noteActivity,
} from "@george43g/robustness";
import { callMcpTool } from "../src/dispatcher.js";

const DURATION_S = Number(process.env.WORKLOAD_DURATION_S ?? 60);
const YIELD_EVERY = 50;

async function main(): Promise<void> {
  installShutdownHandlers();
  installWatchdog();
  logStartup("stress-tui-workload");

  const deadline = Date.now() + DURATION_S * 1000;
  let iter = 0;
  while (Date.now() < deadline) {
    iter++;
    noteActivity();
    await callMcpTool("noop", { input: `iter-${iter}`, upper: iter % 2 === 0 });
    if (iter % YIELD_EVERY === 0) {
      // Yield to event loop so the watchdog can sample.
      await new Promise((resolve) => setImmediate(resolve));
    }
  }
  console.log(`workload completed ${iter} iterations`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
