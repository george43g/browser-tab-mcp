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
import { describe, expect, it } from "vitest";
import { makeAppRegistry } from "../src/tools/registry.js";
import { cliFormOf, cliOnlySurfaces } from "./helpers/cli-surface.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const LEDGER_PATH = resolve(REPO_ROOT, "docs/surfaces/effect-coverage.json");

interface CoverageEntry {
  tier: string;
  covers: string;
  evidence: string;
}
interface SurfaceRow {
  surface: string;
  kind: "tool" | "cli";
  coverage: CoverageEntry[];
}
interface Ledger {
  tiers: Record<string, string>;
  surfaces: SurfaceRow[];
}

const ledger = JSON.parse(readFileSync(LEDGER_PATH, "utf8")) as Ledger;
const toolNames = makeAppRegistry().tools.map((t) => t.name);
const cliOnly = [...cliOnlySurfaces(toolNames)];

/** surface name → the kind the enumeration says it is. */
const enumerated = new Map<string, "tool" | "cli">([
  ...toolNames.map((n) => [n, "tool"] as const),
  ...cliOnly.map((n) => [n, "cli"] as const),
]);

describe("surface-coverage ledger", () => {
  it("enumerates a plausible number of surfaces (canary on both readers)", () => {
    // Both enumerations returning [] would make every assertion below pass
    // vacuously — the failure mode of a registry test, and one this repo has
    // now shipped five times in other shapes.
    expect(toolNames.length, "registry returned no tools").toBeGreaterThan(10);
    expect(cliOnly.length, "commander returned no CLI-only commands").toBeGreaterThan(5);
  });

  it("covers exactly the surfaces that exist", () => {
    const listed = ledger.surfaces.map((s) => s.surface);
    const missing = [...enumerated.keys()].filter((s) => !listed.includes(s));
    const orphaned = listed.filter((s) => !enumerated.has(s));

    expect(
      missing,
      `surface(s) with no ledger row: ${missing.join(", ")}. Add each to ` +
        `docs/surfaces/effect-coverage.json with the tier that will prove its EFFECT ` +
        `and evidence "pending" until something does. A surface with no row is a ` +
        `coverage claim nobody made.`,
    ).toEqual([]);
    expect(
      orphaned,
      `ledger names surface(s) that no longer exist: ${orphaned.join(", ")}. A stale ` +
        `row makes the table look longer than the bin is.`,
    ).toEqual([]);
  });

  it("has no duplicate rows", () => {
    const listed = ledger.surfaces.map((s) => s.surface);
    expect(listed.length, `duplicate surface rows: ${listed.join(", ")}`).toBe(
      new Set(listed).size,
    );
  });

  it("agrees with the enumeration about what kind each surface is", () => {
    for (const row of ledger.surfaces) {
      const kind = enumerated.get(row.surface);
      if (!kind) continue; // already reported by the gap/orphan test
      expect(row.kind, `"${row.surface}" is a ${kind} surface, ledger says "${row.kind}"`).toBe(
        kind,
      );
    }
  });

  it("gives every surface at least one pathway, on a declared tier, with stated evidence", () => {
    const tiers = new Set(Object.keys(ledger.tiers));
    expect(tiers.size, "the tiers block is empty").toBeGreaterThan(0);

    for (const row of ledger.surfaces) {
      expect(
        row.coverage.length,
        `"${row.surface}" has no coverage entry. Every surface has at least one ` +
          `pathway; if nothing will ever prove it, say so in \`covers\` and leave ` +
          `\`evidence\` pending rather than omitting the row.`,
      ).toBeGreaterThan(0);

      const seen = new Set<string>();
      for (const c of row.coverage) {
        expect(
          tiers.has(c.tier),
          `"${row.surface}" claims unknown tier "${c.tier}" (known: ${[...tiers].join(", ")})`,
        ).toBe(true);
        expect(
          seen.has(c.tier),
          `"${row.surface}" has two "${c.tier}" entries — merge them, or the second ` +
            `one silently never gets read.`,
        ).toBe(false);
        seen.add(c.tier);
        // `covers` is what keeps a row from meaning "done" when it means "done
        // through one pathway". An empty one is a row that says nothing.
        expect(
          c.covers.trim().length,
          `"${row.surface}" (${c.tier}) has empty \`covers\``,
        ).toBeGreaterThan(0);
        expect(
          c.evidence.trim().length,
          `"${row.surface}" (${c.tier}) has empty \`evidence\` — use "pending", which ` +
            `claims nothing, rather than an empty string, which looks like a claim.`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it("points every non-pending evidence path at a file that exists", () => {
    // The cheap half of anti-vacuity: a claim naming a deleted file is caught
    // here in seconds. The expensive half — that the named test actually RAN
    // and PASSED for this surface — is e2e/run-guard.ts's job.
    for (const row of ledger.surfaces) {
      for (const c of row.coverage) {
        if (c.evidence === "pending") continue;
        const p = resolve(REPO_ROOT, c.evidence.split(":")[0] ?? "");
        expect(
          existsSync(p),
          `"${row.surface}" (${c.tier}) cites "${c.evidence}", which does not exist.`,
        ).toBe(true);
      }
    }
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
