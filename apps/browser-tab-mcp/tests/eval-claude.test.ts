/**
 * The eval runner's MONEY GUARDS (scripts/eval-claude.mjs). The eval itself
 * needs a real key and real spend — George's to run — but the two refusal
 * paths that keep it from spending accidentally are testable for free, and
 * both fire BEFORE any Anthropic call by construction.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, "../scripts/eval-claude.mjs");

function runEval(extraEnv: Record<string, string | undefined>) {
  return spawnSync(process.execPath, [SCRIPT], {
    env: { ...process.env, ANTHROPIC_API_KEY: undefined, ...extraEnv },
    encoding: "utf8",
    timeout: 30_000,
  });
}

describe("eval-claude money guards", () => {
  it("skips with exit 0 and spends nothing when no key is present", () => {
    const run = runEval({});
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/skipped — no ANTHROPIC_API_KEY/);
    expect(run.stdout).toMatch(/nothing spent/);
  });

  it("refuses before any call when the worst case exceeds the ceiling", () => {
    const run = runEval({
      ANTHROPIC_API_KEY: "sk-dummy-never-used",
      BROWSER_TAB_EVAL_MAX_CALLS: "3",
    });
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/REFUSED — worst case \d+ exceeds the ceiling 3/);
  });
});
