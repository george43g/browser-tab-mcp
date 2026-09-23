/**
 * The ledger covers exactly the surfaces this bin has — no gaps, no orphans.
 *
 * WHAT MAKES "ALL 31 SURFACES" DURABLE RATHER THAN A ONE-TIME SWEEP. A sweep
 * is true on the day it lands and decays silently afterwards: tool #21 gets
 * added, nothing goes red, and the coverage claim quietly becomes false. This
 * test is the thing that decays loudly instead. It never reads a hand-written
 * list — the surface set is enumerated from `makeAppRegistry()` and from
 * commander itself, so the only way to satisfy it is to describe the new
 * surface in `docs/surfaces/effect-coverage.json`.
 *
 * WHAT IT DELIBERATELY DOES NOT CHECK: whether the evidence is real. A path in
 * `evidence` is a claim, and claims about the Chromium tier are enforced where
 * they can actually be observed — `apps/chrome-extension/e2e/run-guard.ts`
 * fails a run whose ledger claims a chromium-e2e surface that no PASSING test
 * annotated. This file owns the shape; the guard owns the truth. Neither one
 * alone is sufficient, which is why both exist.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type Ledger, ledgerProblems } from "@george43g/test-kit/contracts";
import { describe, expect, it } from "vitest";
import { makeAppRegistry } from "../src/tools/registry.js";
import { cliOnlySurfaces } from "./helpers/cli-surface.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const LEDGER_PATH = resolve(REPO_ROOT, "docs/surfaces/effect-coverage.json");

/**
 * This app's rows only. The ledger holds every MCP app's surfaces, and several
 * names repeat across apps (health_check, get_logs, mcp, tui…) — read
 * unscoped, another app's row would keep a deleted browser-tab surface
 * "covered". Measured when tmux-control's rows landed: the unscoped gap/orphan
 * check still passed; only the duplicate check went red.
 */
const APP = "browser-tab-mcp";

const fullLedger = JSON.parse(readFileSync(LEDGER_PATH, "utf8")) as Ledger;
const ledger: Ledger = {
  ...fullLedger,
  surfaces: fullLedger.surfaces.filter((s) => s.app === APP),
};
const toolNames = makeAppRegistry().tools.map((t) => t.name);
const cliOnly = [...cliOnlySurfaces(toolNames)];

describe("surface-coverage ledger", () => {
  it("enumerates a plausible number of surfaces (canary on both readers)", () => {
    // Both enumerations returning [] would make every assertion below pass
    // vacuously — the failure mode of a registry test, and one this repo has
    // now shipped five times in other shapes.
    expect(toolNames.length, "registry returned no tools").toBeGreaterThan(10);
    expect(cliOnly.length, "commander returned no CLI-only commands").toBeGreaterThan(5);
    expect(ledger.surfaces.length, `no ledger rows carry "app": "${APP}"`).toBeGreaterThan(10);
  });

  it("covers exactly the surfaces that exist, each with a declared tier and stated evidence", () => {
    // Gaps, orphans, duplicates, kind, tier, `covers`, `evidence`, and that a
    // non-pending evidence path exists — shared with every other MCP app via
    // @george43g/test-kit/contracts. A surface with no row is a coverage claim
    // nobody made; add it with the tier that will prove its EFFECT and
    // evidence "pending" until something does.
    expect(ledgerProblems({ ledger, app: APP, toolNames, cliOnly, repoRoot: REPO_ROOT })).toEqual(
      [],
    );
  });

  it("backs every macos-local claim with a PASSING row in the sweep report", () => {
    // The macos-local half of the anti-vacuity rule, and the exact analogue of
    // what `e2e/run-guard.ts` does for the Chromium tier: a `tier` plus an
    // `evidence` path is a CLAIM, and a claim nobody checks is how this repo
    // shipped five harnesses that passed while proving nothing.
    //
    // It works here — where a reporter cannot, because `pnpm sweep:macos`
    // cannot run in CI — because the report is COMMITTED. So the assertion is
    // against a real artifact at a real commit, not against a run.
    //
    // The consequence is deliberate: re-running the sweep on a machine where a
    // surface newly skips (no Screen Recording consent, a tiling WM, a browser
    // that will not launch) rewrites the report, and this test goes red until
    // the ledger row is put back to "pending". That is correct. The claim
    // genuinely stopped being backed, and the alternative — a green test over
    // a report that no longer says what the ledger says — is the failure mode.
    const reportPath = resolve(REPO_ROOT, "apps/browser-tab-mcp/sweep-macos-report.json");
    if (!existsSync(reportPath)) {
      // Nothing has been swept yet. Then no row may claim the report either,
      // which the "evidence path exists" test above already enforces.
      return;
    }
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      results: { surface: string; status: string; reason?: string }[];
    };
    const proved = new Set(report.results.filter((r) => r.status === "pass").map((r) => r.surface));
    for (const row of ledger.surfaces) {
      for (const c of row.coverage) {
        if (c.tier !== "macos-local" || c.evidence === "pending") continue;
        expect(
          proved.has(row.surface),
          `"${row.surface}" claims macos-local evidence in ${c.evidence}, but that report has ` +
            `no PASSING row for it. Either re-run \`pnpm sweep:macos\` on a Mac where the ` +
            `surface can actually be exercised, or set this row's evidence back to "pending" — ` +
            `a claim is not allowed to outlive the run that backed it.`,
        ).toBe(true);
      }
    }
  });

  it("still describes the AppleScript pathways the Chromium tier cannot reach", () => {
    // The decision this ledger exists to keep honest (George, 2026-08-23:
    // "All 31 surfaces", taken AFTER being told ~9 are AppleScript-only). If a
    // future edit quietly drops the macos-local rows, "all 31" starts meaning
    // "all 31 through whichever pathway was easiest".
    const macos = ledger.surfaces.filter((s) => s.coverage.some((c) => c.tier === "macos-local"));
    expect(
      macos.length,
      "no surface claims a macos-local pathway — the AppleScript half of this tool " +
        "has not stopped existing, so something was deleted rather than closed.",
    ).toBeGreaterThanOrEqual(9);
  });
});
