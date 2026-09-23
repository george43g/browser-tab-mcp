/**
 * Every subcommand must brand its log directory — asserted BEHAVIOURALLY.
 *
 * WHY THIS SHAPE, AND WHY THREE SIMPLER VERSIONS WERE REJECTED
 *
 * The logger fixes its file path at the FIRST WRITE and derives the directory
 * from whatever prefix is set at that instant. Two different defects put logs
 * in the shared `$TMPDIR/mcp/` bucket: branding called too LATE, and branding
 * NEVER called. A third cause turned out to be neither — a dependency
 * resolving its own copy of the logger, so the app branded an instance the
 * dispatcher never wrote through.
 *
 * Three cheaper checks were considered and rejected:
 *
 *  1. "Assert every entry point calls setLogFilePrefix" — a static list. It
 *     would have caught `cli.ts` only if somebody had listed `cli.ts`, which is
 *     exactly what nobody did. And `commands/http.ts` has zero calls and is
 *     nonetheless correct, so the check has to reason about that false positive
 *     to stay useful.
 *  2. A runtime warning emitted through the logger — it would be written INTO
 *     the mis-located file, the one directory nothing collects.
 *  3. A hook at the logger's first file open — a default nobody overrode is
 *     indistinguishable from a default nobody meant to override, so it
 *     false-positives on every tool that never brands deliberately.
 *
 * This asserts the OBSERVABLE OUTCOME instead, so it catches all three causes
 * without needing to tell them apart — including causes nobody has thought of.
 *
 * THE SUBCOMMAND LIST COMES FROM THE BIN'S OWN `--help`, never from a literal
 * here. A hand-written list is the same failure as (1): a subcommand added
 * tomorrow is covered the day it is registered, not the day someone remembers
 * to update this file.
 *
 * ACCEPTED GAP, stated rather than papered over: library entry points imported
 * in-process (vitest workers) are not covered. How to cover them is unknown and
 * was deliberately not invented.
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const APP_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const BIN = join(APP_ROOT, "dist", "cli.js");

/** The prefix the logger falls back to when nobody brands. Its directory is the bug. */
const DEFAULT_PREFIX = "mcp";

/** Subcommands that never exit on their own; spawn, wait for output, then kill. */
const LONG_RUNNING = new Set(["mcp", "tui", "repl", "http"]);

/** Flags required by subcommands that would otherwise fail before logging. */
const REQUIRED_ARGS: Record<string, string[]> = { noop: ["--input", "x"] };

const sandboxes: string[] = [];
afterAll(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true });
});

/** Enumerate from the bin itself — never a literal list. See the header. */
function subcommands(): string[] {
  const help = execFileSync("node", [BIN, "--help"], { encoding: "utf8", timeout: 30_000 });
  const body = help.split(/^Commands:/m)[1] ?? "";
  const names = new Set<string>();
  for (const line of body.split("\n")) {
    const m = /^\s{2}([a-z][a-z0-9-]*)/.exec(line);
    if (m?.[1] && m[1] !== "help") names.add(m[1]);
  }
  return [...names];
}

async function runIsolated(sub: string): Promise<string> {
  const sandbox = mkdtempSync(join(tmpdir(), "log-prefix-"));
  sandboxes.push(sandbox);
  const env = { ...process.env, TMPDIR: sandbox, MCP_LOG_TO_FILE: "1" };
  const args = [BIN, sub, ...(REQUIRED_ARGS[sub] ?? [])];

  if (!LONG_RUNNING.has(sub)) {
    try {
      execFileSync("node", args, { env, timeout: 30_000, stdio: "ignore" });
    } catch {
      // A non-zero exit is fine. We assert WHERE it logged, not that it succeeded —
      // a subcommand that fails still had to open a log file to say so.
    }
    return sandbox;
  }

  const child = spawn("node", args, { env, stdio: "ignore" });

  // Stop waiting as soon as EITHER a log lands or the child exits. `tui` and
  // `repl` refuse to start without a TTY, so under a test runner they exit
  // immediately and never log — waiting a fixed interval for them is what blew
  // vitest's default 5s timeout on this file's first run.
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !exited && readdirSync(sandbox).length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  child.kill("SIGTERM");
  return sandbox;
}

/**
 * Named rather than inline in `it.each` below: biome 2.5.3 and 2.5.5 format an
 * inline callback followed by a timeout argument differently, so the inline form
 * failed `biome check` in consumer repos pinned to the other version.
 */
async function assertNoDefaultPrefixDir(sub: string): Promise<void> {
  const sandbox = await runIsolated(sub);
  const defaultDir = join(sandbox, DEFAULT_PREFIX);
  const found = existsSync(defaultDir) ? readdirSync(defaultDir) : [];
  expect(
    found,
    `${sub} logged to the shared default-prefix directory. Either an entry point does ` +
      "not import ./log-brand.js first, or a dependency resolved its own copy of " +
      "@george43g/robustness and is writing through an instance this app cannot brand.",
  ).toEqual([]);
}

describe("every subcommand brands its log directory", () => {
  const subs = subcommands();

  it("finds subcommands from the bin's own --help, not a literal list", () => {
    // If this ever returns nothing, every test below passes vacuously — which is
    // the reassuring reading, so it has to fail loudly instead.
    expect(subs.length).toBeGreaterThan(0);
    expect(subs).toContain("mcp");
  });

  it.each(subs)("`%s` writes no $TMPDIR/mcp/ directory", assertNoDefaultPrefixDir, 30_000);
});
