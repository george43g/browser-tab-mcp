/**
 * Playwright reporter that fails a run which passed without proving anything.
 *
 * THE FAILURE MODE. `pnpm --filter @george43g/chrome-extension test:e2e` exits
 * 0 when zero tests match, when a whole spec file is skipped, and when a
 * `beforeAll` quietly bails. It also exits 0 while
 * `docs/surfaces/effect-coverage.json` claims a dozen surfaces are
 * effect-verified here. None of those are hypothetical: this repo has shipped
 * five separate harnesses that passed while proving nothing, which is why the
 * guard lands BEFORE the sweep rather than after it.
 *
 * The verdict logic is in `run-guard-core.ts` — pure, `@playwright/test`-free,
 * and driven by `apps/chrome-extension/tests/run-guard.test.ts` in the cheap
 * vitest run. This file is only the plumbing: collect results, read the
 * ledger, print, write the report, override the status.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter";
import { E2E_SPEC_SLOTS } from "./ports.js";
import { guardVerdict, type RunStatus, type TestRecord } from "./run-guard-core.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const LEDGER = resolve(REPO_ROOT, "docs/surfaces/effect-coverage.json");
const REPORT = resolve(HERE, "..", "e2e-coverage.json");

/**
 * Floor on how many tests must run. RAISE-ONLY: lowering it to make a run
 * green is the exact move this guard exists to catch. Sixty is today's suite
 * (load × 1, roundtrip × 2, tabs-lifecycle × 8, tab-action × 7,
 * tab-history × 3, tab-discard × 1, groups × 5, windows × 5, move-tab × 4,
 * content × 7, capture × 3, journal-history-bookmarks × 6,
 * daemon-surfaces × 6, reload-extension × 2); Phase 2 raises it as specs
 * land.
 */
export const EXPECTED_MIN_TESTS = 70;

/**
 * Spec files allowed to contribute no non-skipped test, with the reason.
 * Empty on purpose — an entry here is an exemption from the participation
 * check, and every one costs a line of justification that outlives whoever
 * added it.
 */
export const SKIP_ALLOWLIST: Readonly<Record<string, string>> = {};

interface LedgerRow {
  surface: string;
  coverage: Array<{ tier: string; evidence: string }>;
}

function readLedger(): { claimed: string[]; known: string[] } {
  const parsed = JSON.parse(readFileSync(LEDGER, "utf8")) as { surfaces: LedgerRow[] };
  return {
    known: parsed.surfaces.map((s) => s.surface),
    claimed: parsed.surfaces
      .filter((s) => s.coverage.some((c) => c.tier === "chromium-e2e" && c.evidence !== "pending"))
      .map((s) => s.surface),
  };
}

export default class RunGuard implements Reporter {
  /** Keyed by test id so a retry OVERWRITES rather than double-counting. */
  private readonly records = new Map<string, TestRecord>();

  onTestEnd(test: TestCase, result: TestResult): void {
    this.records.set(test.id, {
      file: basename(test.location.file),
      title: test.titlePath().slice(3).join(" › ") || test.title,
      status: result.status,
      retry: result.retry,
      surfaces: result.annotations
        .filter((a) => a.type === "surface")
        .map((a) => a.description ?? "")
        .filter((d) => d.length > 0),
    });
  }

  async onEnd(result: FullResult): Promise<{ status?: FullResult["status"] } | undefined> {
    const records = [...this.records.values()];
    const { claimed, known } = readLedger();
    const verdict = guardVerdict({
      records,
      registeredSpecs: E2E_SPEC_SLOTS,
      claimedSurfaces: claimed,
      knownSurfaces: known,
      minTests: EXPECTED_MIN_TESTS,
      skipAllowlist: SKIP_ALLOWLIST,
      runStatus: result.status as RunStatus,
    });

    // Retry counts ride the report on purpose: `retries: 1` in CI absorbs
    // chronic flake into a green run, and a number nobody writes down is a
    // number nobody notices climbing.
    writeFileSync(
      REPORT,
      `${JSON.stringify(
        {
          runStatus: result.status,
          guard: { ok: verdict.ok, findings: verdict.findings },
          summary: verdict.summary,
          tests: records,
        },
        null,
        2,
      )}\n`,
    );

    if (verdict.findings.length > 0) {
      const header = verdict.shouldFail
        ? "run guard FAILED an otherwise-green run:"
        : "run guard findings (the run had already failed; these decide nothing):";
      process.stderr.write(`\n${header}\n`);
      for (const f of verdict.findings) process.stderr.write(`  • ${f}\n`);
      process.stderr.write(`\nreport: ${REPORT}\n\n`);
    }

    return verdict.shouldFail ? { status: "failed" } : undefined;
  }
}
