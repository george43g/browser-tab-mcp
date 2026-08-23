/**
 * The run guard's verdict logic, driven where it is cheap to drive.
 *
 * WHY THIS EXISTS. A guard nobody can test is a guard nobody trusts, and the
 * only other way to observe this one is a full Playwright run behind a browser
 * install. Every case below is a way an e2e suite has actually gone quiet
 * somewhere: zero tests collected, a file that stopped participating, a
 * coverage claim with nothing behind it.
 *
 * The reporter plumbing (`run-guard.ts`) is deliberately NOT covered here — it
 * imports `@playwright/test/reporter`. What it does is read results, read the
 * ledger, and call `guardVerdict`; the decisions are all here.
 */

import { describe, expect, it } from "vitest";
import {
  annotationProves,
  type GuardInput,
  guardVerdict,
  type TestRecord,
} from "../e2e/run-guard-core.js";

const rec = (over: Partial<TestRecord> = {}): TestRecord => ({
  file: "roundtrip.e2e.test.ts",
  title: "does a thing",
  status: "passed",
  retry: 0,
  surfaces: [],
  ...over,
});

const input = (over: Partial<GuardInput> = {}): GuardInput => ({
  records: [rec(), rec({ file: "load.e2e.test.ts" }), rec({ title: "another" })],
  registeredSpecs: ["load.e2e.test.ts", "roundtrip.e2e.test.ts"],
  claimedSurfaces: [],
  knownSurfaces: ["list_tabs", "move_tab", "tab_action"],
  minTests: 3,
  skipAllowlist: {},
  runStatus: "passed",
  ...over,
});

describe("annotationProves", () => {
  it("matches a surface exactly, and its sub-commands", () => {
    expect(annotationProves("tab_action", "tab_action")).toBe(true);
    expect(annotationProves("tab_action:pin", "tab_action")).toBe(true);
  });

  it("does not match a surface that merely shares a prefix", () => {
    // `open_tab` must not be proved by an annotation for `open_tabs_bulk`, and
    // `list_tabs` must not be proved by `list`. Prefix matching without the
    // separator is how a guard starts crediting the wrong test.
    expect(annotationProves("open_tabs_bulk", "open_tab")).toBe(false);
    expect(annotationProves("list", "list_tabs")).toBe(false);
  });
});

describe("guardVerdict", () => {
  it("passes a healthy run and says what it saw", () => {
    const v = guardVerdict(input());
    expect(v.findings).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.shouldFail).toBe(false);
    expect(v.summary.ran).toBe(3);
    expect(v.summary.filesParticipating).toEqual(["load.e2e.test.ts", "roundtrip.e2e.test.ts"]);
  });

  it("fails a run that collapsed to too few tests", () => {
    const v = guardVerdict(input({ records: [rec()], minTests: 3 }));
    expect(v.shouldFail).toBe(true);
    expect(v.findings.join()).toMatch(/only 1 test\(s\) ran/);
  });

  it("fails when a registered spec contributed nothing", () => {
    const v = guardVerdict(input({ records: [rec(), rec({ title: "b" }), rec({ title: "c" })] }));
    expect(v.shouldFail).toBe(true);
    expect(v.findings.join()).toMatch(/load\.e2e\.test\.ts.*contributed no non-skipped/s);
  });

  it("counts a skipped test as not participating", () => {
    // The exact shape of a file going quiet: it is collected, so a naive
    // per-file check sees it; every test inside is skipped.
    const v = guardVerdict(
      input({
        records: [
          rec(),
          rec({ title: "b" }),
          rec({ title: "c" }),
          rec({ file: "load.e2e.test.ts", status: "skipped" }),
        ],
      }),
    );
    expect(v.shouldFail).toBe(true);
    expect(v.findings.join()).toMatch(/load\.e2e\.test\.ts/);
    expect(v.summary.skipped).toBe(1);
  });

  it("honours an allowlisted spec, and only that one", () => {
    const v = guardVerdict(
      input({
        records: [rec(), rec({ title: "b" }), rec({ title: "c" })],
        skipAllowlist: { "load.e2e.test.ts": "needs a display server" },
      }),
    );
    expect(v.findings).toEqual([]);
  });

  it("rejects an allowlist entry that is stale — file gone", () => {
    const v = guardVerdict(input({ skipAllowlist: { "deleted.e2e.test.ts": "why" } }));
    expect(v.shouldFail).toBe(true);
    expect(v.findings.join()).toMatch(/not a registered spec/);
  });

  it("rejects an allowlist entry for a file that is pulling its weight", () => {
    const v = guardVerdict(input({ skipAllowlist: { "load.e2e.test.ts": "why" } }));
    expect(v.shouldFail).toBe(true);
    expect(v.findings.join()).toMatch(/but it ran tests/);
  });

  it("fails a ledger claim that no passing test annotated", () => {
    const v = guardVerdict(input({ claimedSurfaces: ["move_tab"] }));
    expect(v.shouldFail).toBe(true);
    expect(v.findings.join()).toMatch(/claims "move_tab".*no PASSING test annotated/s);
  });

  it("does not accept an annotation from a FAILING test as proof", () => {
    // The whole point of reading annotations off results rather than off test
    // declarations: a test that asserts the surface and then fails has proved
    // the opposite of what the ledger claims.
    const v = guardVerdict(
      input({
        records: [
          rec({ status: "failed", surfaces: ["move_tab"] }),
          rec({ title: "b" }),
          rec({ file: "load.e2e.test.ts" }),
        ],
        claimedSurfaces: ["move_tab"],
        runStatus: "passed",
      }),
    );
    expect(v.ok).toBe(false);
    expect(v.findings.join()).toMatch(/no PASSING test annotated/);
  });

  it("accepts a sub-command annotation as proof of its surface", () => {
    const v = guardVerdict(
      input({
        records: [
          rec({ surfaces: ["tab_action:pin"] }),
          rec({ title: "b" }),
          rec({ file: "load.e2e.test.ts" }),
        ],
        claimedSurfaces: ["tab_action"],
      }),
    );
    expect(v.findings).toEqual([]);
    expect(v.summary.surfacesProved).toEqual(["tab_action:pin"]);
  });

  it("fails an annotation the ledger still calls pending (under-claiming)", () => {
    const v = guardVerdict(
      input({
        records: [
          rec({ surfaces: ["move_tab"] }),
          rec({ title: "b" }),
          rec({ file: "load.e2e.test.ts" }),
        ],
        claimedSurfaces: [],
      }),
    );
    expect(v.shouldFail).toBe(true);
    expect(v.findings.join()).toMatch(/still records that surface as evidence:"pending"/);
  });

  it("fails an annotation that matches no surface at all (a typo)", () => {
    const v = guardVerdict(
      input({
        records: [
          rec({ surfaces: ["move_tabb"] }),
          rec({ title: "b" }),
          rec({ file: "load.e2e.test.ts" }),
        ],
      }),
    );
    expect(v.shouldFail).toBe(true);
    expect(v.findings.join()).toMatch(/matches no surface in the ledger/);
  });

  it("reports but does not decide when the run had already failed", () => {
    // Cascade suppression. A serial describe skips everything after a failure,
    // so checks 2-4 all fire on a genuinely-failing run; letting them speak
    // would bury Playwright's own, better diagnostics behind guard noise.
    const v = guardVerdict(input({ records: [rec()], runStatus: "failed" }));
    expect(v.ok).toBe(false);
    expect(v.findings.length).toBeGreaterThan(0);
    expect(v.shouldFail).toBe(false);
  });

  it("counts retries, so chronic flake is visible under retries: 1", () => {
    const v = guardVerdict(
      input({
        records: [rec({ retry: 1 }), rec({ title: "b" }), rec({ file: "load.e2e.test.ts" })],
      }),
    );
    expect(v.summary.retried).toBe(1);
    // Deliberately NOT a finding: one retry is what `retries: 1` is for. The
    // number rides the report so a climb is visible without being a gate.
    expect(v.findings).toEqual([]);
  });
});
