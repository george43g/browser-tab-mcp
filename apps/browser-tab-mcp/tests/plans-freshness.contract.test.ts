/**
 * An active plan must say what state it is in — and not lie about it.
 *
 * ADOPTED, NOT INVENTED. The three rules below are the life-stack session's
 * (`check:stale-plans`, its commit `da7e384`, 2026-09-07), handed over with
 * both of the traps that bit their implementation. What is NOT adopted is the
 * ~200-line standalone script: this repo enforces through contract tests that
 * `pnpm test` already runs, and a separate check would be precisely the
 * orphaned-check problem BACKLOG **B27** exists to solve. Same rules, this
 * repo's mechanism.
 *
 * WHY THE RULES EXIST. Five plans in this directory all went quiet on
 * 2026-08-22, which usually means a context ended rather than five plans each
 * independently finishing — and none of them carried any status at all, so the
 * only way to tell a live plan from a dead one was to read all five and then
 * go check the repo. Three were shipped, one was half done, one was
 * superseded. (Sweep row `btm-plans`, 2026-09-07.)
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const PLANS = join(ROOT, "docs/agent-handoff/plans");
const STALE_DAYS = 30;

/**
 * Terminal states, matched as WHOLE WORDS with an explicit non-terminal veto.
 *
 * Trap 1, from life-stack: `PARTIALLY EXECUTED` contains `EXECUTED`, so a
 * substring match silently exempts exactly the plans most likely to rot — the
 * half-finished ones. This repo has one right now
 * (cg-oscillation-instrumentation), which is why its status deliberately says
 * "LIVE, HALF DONE" rather than "partially executed".
 */
const TERMINAL = /\b(SHIPPED|SUPERSEDED|ABANDONED|PARKED|ARCHIVED)\b/;
const NON_TERMINAL = /\b(PARTIAL|PARTIALLY|HALF DONE|IN PROGRESS|LIVE)\b/;

const activePlans = (): string[] =>
  readdirSync(PLANS).filter((f) => f.endsWith(".md") && f !== "README.md");

const head = (file: string, lines = 20): string =>
  readFileSync(join(PLANS, file), "utf8").split("\n").slice(0, lines).join("\n");

describe("active plans declare their state", () => {
  it("finds a real sample of plans (anti-vacuity)", () => {
    // A glob that matched nothing would make every rule below pass silently.
    expect(activePlans().length).toBeGreaterThan(3);
  });

  it("does not treat a HALF-DONE plan as terminal (the substring trap)", () => {
    // life-stack's trap, asserted rather than merely commented: `PARTIALLY
    // EXECUTED` contains `EXECUTED`, and a checker that substring-matches
    // exempts exactly the plans most likely to rot.
    const terminal = (s: string) => TERMINAL.test(s) && !NON_TERMINAL.test(s);
    expect(terminal("**STATUS 2026-09-07 — SHIPPED.**")).toBe(true);
    expect(terminal("**STATUS 2026-09-07 — SUPERSEDED.**")).toBe(true);
    expect(terminal("**STATUS 2026-09-07 — PARTIALLY EXECUTED.**")).toBe(false);
    expect(terminal("**STATUS 2026-09-07 — LIVE, HALF DONE.**")).toBe(false);
    expect(terminal("**STATUS 2026-09-07 — SHIPPED in part, LIVE for the rest.**")).toBe(false);
  });

  it.each(activePlans())("%s carries a STATUS line in its first 20 lines", (file) => {
    expect(
      head(file),
      `no dated STATUS line near the top of ${file}. A reader must be able to tell a live plan ` +
        `from a dead one without reading it, and an UNDATED status is how a claim goes stale ` +
        `unnoticed — add "> **STATUS <YYYY-MM-DD> — …**" after the H1.`,
    ).toMatch(/\*\*STATUS[^\n]*\d{4}-\d{2}-\d{2}/);
  });

  it.each(activePlans())("%s: its STATUS does not contradict its own body", (file) => {
    const text = readFileSync(join(PLANS, file), "utf8");
    const status = /\*\*STATUS[^\n]*\n(?:>[^\n]*\n)*/.exec(text)?.[0] ?? "";
    const bodyClaimsDone = /^#{1,4} .*\b(BUILT|SHIPPED|COMPLETE|EXECUTED)\b/m.test(
      text.slice(status.length ? text.indexOf(status) + status.length : 0),
    );
    const statusSaysTerminal = TERMINAL.test(status) && !NON_TERMINAL.test(status);
    if (bodyClaimsDone) {
      expect(
        statusSaysTerminal,
        `${file} has a completion heading in its body while its STATUS says otherwise. ` +
          `This is the exact failure that let a plan read "nothing built, nothing shipped" ` +
          `for thirteen days with "## BUILT" 200 lines below it.`,
      ).toBe(true);
    }
  });

  it("a non-terminal plan untouched for 30 days must be parked deliberately", () => {
    // Trap 2, from life-stack: on a SHALLOW clone `git log -1 -- <file>` returns
    // HEAD's own timestamp for every file, so this rule passes vacuously and
    // looks green. actions/checkout defaults to fetch-depth: 1.
    const shallow =
      execFileSync("git", ["rev-parse", "--is-shallow-repository"], {
        cwd: ROOT,
        encoding: "utf8",
      }).trim() === "true";
    if (shallow) {
      // Skipping loudly beats passing quietly: the assertion below cannot mean
      // anything here, and pretending it did is worse than not running it.
      expect(shallow, "shallow clone — staleness unmeasurable, rule skipped").toBe(true);
      return;
    }
    const stale: string[] = [];
    for (const file of activePlans()) {
      const iso = execFileSync("git", ["log", "-1", "--format=%cI", "--", join(PLANS, file)], {
        cwd: ROOT,
        encoding: "utf8",
      }).trim();
      if (!iso) continue; // never committed — a brand-new plan, not a stale one
      const days = (Date.now() - Date.parse(iso)) / 86_400_000;
      const status =
        /\*\*STATUS[^\n]*\n(?:>[^\n]*\n)*/.exec(readFileSync(join(PLANS, file), "utf8"))?.[0] ?? "";
      const terminal = TERMINAL.test(status) && !NON_TERMINAL.test(status);
      if (days > STALE_DAYS && !terminal) stale.push(`${file} (${Math.floor(days)}d)`);
    }
    expect(
      stale,
      `plan(s) with no commit in ${STALE_DAYS} days and no terminal STATUS. Either work them, ` +
        `or give them a dated PARKED/SUPERSEDED status — silence is how a dead plan keeps ` +
        `looking live:\n  ${stale.join("\n  ")}`,
    ).toEqual([]);
  });
});
