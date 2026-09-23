/**
 * An inventory guard, not a style rule.
 *
 * `node_modules/.bin/tsx` is a supervisor, not a runner: it spawns your code as
 * a grandchild and relays signals to it on a 30ms IPC-ack budget, then
 * `kill("SIGKILL")`s it when the ack is late — which a loaded machine misses
 * routinely and an idle laptop never does. Anything that signals such a child,
 * or reads its exit status, is measuring the wrapper rather than the app.
 *
 * Killing the process GROUP does not save you: the wrapper is in the same
 * group, receives the signal too, and escalates anyway. Measured.
 *
 * This is not a hypothetical. It sat live in two `stress-mcp.ts` assertions and
 * in `mcp-dev-proxy.ts`'s restart path, and the same defect was independently
 * confirmed in four consumer repos on the same day.
 *
 * So: every remaining `.bin/tsx` call site is listed below BY NAME with the
 * reason it is safe. A new one fails this test, which forces the question
 * rather than leaving it to be rediscovered from a red CI leg three months on.
 *
 * To spawn a TS entry safely:
 *
 *   const TSX_IMPORT = ["--import", pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href];
 *   spawn(process.execPath, [...TSX_IMPORT, ENTRY], { ... })
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const APP_DIR = resolve(import.meta.dirname, "..");
const SCANNED = ["src", "tests", "scripts"];

/**
 * Call sites that spawn through the tsx CLI and are DELIBERATELY left there.
 * Adding an entry is a decision; the comment is the justification.
 */
const ALLOWED = new Map<string, string>([
  [
    "scripts/stress-tui.ts",
    "Signals a deliberately lagged workload, so tsx does kill it — but nothing " +
      "reads that child's exit status and the report is written by the parent " +
      "from samples already collected. Owns no external state to leak.",
  ],
  [
    "tests/repl-pipe.test.ts",
    "Never signals its child: closes stdin and waits for a natural exit, which " +
      "is outside the relay's reach entirely.",
  ],
]);

/** A line that mentions the path in prose rather than constructing one. */
function isComment(line: string): boolean {
  const t = line.trim();
  return t.startsWith("*") || t.startsWith("//") || t.startsWith("/*");
}

function* walk(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      yield* walk(full);
      continue;
    }
    if (/\.(ts|tsx|mts|mjs|js)$/.test(entry)) yield full;
  }
}

describe("tsx spawn inventory", () => {
  it("has no unreviewed `.bin/tsx` call site", () => {
    const found = new Set<string>();
    const scanned: string[] = [];
    for (const dir of SCANNED) {
      for (const file of walk(join(APP_DIR, dir))) {
        const rel = relative(APP_DIR, file).split("\\").join("/");
        scanned.push(rel);
        // This file is the inventory; its own prose naming the path is not a site.
        if (rel === "tests/tsx-spawn-inventory.test.ts") continue;
        const hit = readFileSync(file, "utf8")
          .split("\n")
          .some((line) => line.includes("bin/tsx") && !isComment(line));
        if (hit) found.add(rel);
      }
    }

    // POSITIVE CONTROL, and it is the whole reason this guard can be trusted.
    //
    // Every assertion below is of the form "we found no violations", which is
    // exactly what a BROKEN SCAN also reports. A wrong cwd, an extension filter
    // that matches nothing, a `SCANNED` entry that silently yields zero files —
    // each turns this test green while checking nothing.
    //
    // So assert the scan itself worked, in a shape that fails if the
    // enumeration layer breaks rather than re-running the same sweep and
    // calling that confirmation. Contributed by the eqstack session, applying
    // back the rule this repo had just written down and then not applied here.
    expect(
      scanned.length,
      "file scan returned almost nothing — the walk is broken",
    ).toBeGreaterThan(15);
    expect(scanned, "the walk missed a file that certainly exists").toContain(
      "scripts/stress-tui.ts",
    );

    const unreviewed = [...found].filter((f) => !ALLOWED.has(f)).sort();
    expect(
      unreviewed,
      `New \`node_modules/.bin/tsx\` call site(s). tsx SIGKILLs its grandchild ` +
        `when the child's 30ms IPC signal-ack is late, so anything that signals ` +
        `this child or reads its exit status will fail on a loaded runner and ` +
        `pass on your laptop. Use \`node --import <tsx loader> <entry>\` instead ` +
        `— or add the file to ALLOWED in this test with the reason it is safe.`,
    ).toEqual([]);

    // The other direction: an entry that no longer matches anything is a stale
    // exemption, and a stale exemption is how an allowlist stops meaning
    // anything. Fail so it gets deleted.
    const stale = [...ALLOWED.keys()].filter((f) => !found.has(f)).sort();
    expect(stale, "Stale ALLOWED entries — the call site is gone; delete them.").toEqual([]);
  });
});
