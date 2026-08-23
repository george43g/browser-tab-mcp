/**
 * The run guard's verdict, as a pure function.
 *
 * WHY THIS IS SEPARATE FROM THE REPORTER. A Playwright reporter can only be
 * observed by running Playwright, which needs a browser install and a real
 * daemon. A guard you cannot cheaply test is a guard nobody verifies — and
 * "the apparatus passed while proving nothing" is this repo's most-repeated
 * failure, now at five instances. So the decisions live here, with no
 * `@playwright/test` import, and `apps/chrome-extension/tests/run-guard.test.ts`
 * drives them in the cheap `pnpm test`.
 *
 * WHAT IT GUARDS. Three ways an e2e suite can go quiet without going red:
 *   1. the run collapses to a handful of tests and still exits 0;
 *   2. a whole spec file stops contributing (renamed, skipped, or wedged in a
 *      `beforeAll`) and the remaining files carry the run;
 *   3. `docs/surfaces/effect-coverage.json` claims a surface is effect-verified
 *      here and no passing test ever touched it.
 *
 * (3) is the one that matters most. The ledger is a set of claims; without
 * this, a claim costs a line of JSON and proves nothing.
 */

/** The run-level status Playwright reports; mirrored so this file stays import-free. */
export type RunStatus = "passed" | "failed" | "timedout" | "interrupted";

export interface TestRecord {
  /** Spec basename, e.g. "roundtrip.e2e.test.ts". */
  file: string;
  title: string;
  status: "passed" | "failed" | "timedOut" | "skipped" | "interrupted";
  /** Playwright's retry index of the attempt this record came from (0 = first). */
  retry: number;
  /** `surface` annotation descriptions carried by this attempt. */
  surfaces: string[];
}

export interface GuardInput {
  records: readonly TestRecord[];
  /** Every spec file that must participate — `E2E_SPEC_SLOTS` from ports.ts. */
  registeredSpecs: readonly string[];
  /** Surfaces the ledger claims are proved on THIS tier (evidence !== "pending"). */
  claimedSurfaces: readonly string[];
  /** Every surface the ledger knows about, for typo detection. */
  knownSurfaces: readonly string[];
  minTests: number;
  /** Spec basename → why it is allowed to contribute nothing. Reason required. */
  skipAllowlist: Readonly<Record<string, string>>;
  /** What Playwright decided before the guard ran. */
  runStatus: RunStatus;
}

export interface GuardVerdict {
  /** False only when the guard itself found something. */
  ok: boolean;
  findings: string[];
  /** True when the guard should override the run status to "failed". */
  shouldFail: boolean;
  summary: {
    total: number;
    ran: number;
    passed: number;
    skipped: number;
    retried: number;
    filesParticipating: string[];
    surfacesProved: string[];
  };
}

/**
 * An annotation proves a surface when it names it exactly, or names a
 * sub-command of it (`tab_action:pin` proves `tab_action`).
 *
 * The finer form is deliberate: per-command annotations are what keep the
 * failure message useful when one action of eleven regresses. The ledger stays
 * at surface granularity because that is the unit the registry enumerates.
 */
export function annotationProves(annotation: string, surface: string): boolean {
  return annotation === surface || annotation.startsWith(`${surface}:`);
}

export function guardVerdict(input: GuardInput): GuardVerdict {
  const {
    records,
    registeredSpecs,
    claimedSurfaces,
    knownSurfaces,
    minTests,
    skipAllowlist,
    runStatus,
  } = input;

  const ran = records.filter((r) => r.status !== "skipped");
  const passed = records.filter((r) => r.status === "passed");
  const filesParticipating = [...new Set(ran.map((r) => r.file))].sort();
  const provedBy = new Map<string, string[]>();
  for (const r of passed) {
    for (const s of r.surfaces) {
      provedBy.set(s, [...(provedBy.get(s) ?? []), `${r.file} › ${r.title}`]);
    }
  }

  const findings: string[] = [];

  // 1 — the run did not collapse.
  if (ran.length < minTests) {
    findings.push(
      `only ${ran.length} test(s) ran; at least ${minTests} were expected. Either specs ` +
        `stopped being collected (check testMatch and the file names) or something ` +
        `skipped them wholesale.`,
    );
  }

  // 2 — every registered spec contributed something.
  for (const spec of registeredSpecs) {
    if (filesParticipating.includes(spec)) continue;
    const reason = skipAllowlist[spec];
    if (reason) continue;
    findings.push(
      `spec "${spec}" is registered in E2E_SPEC_SLOTS but contributed no non-skipped ` +
        `test. A whole file going quiet looks exactly like a passing run. If that is ` +
        `intended, add it to SKIP_ALLOWLIST in run-guard.ts with the reason.`,
    );
  }
  // …and the allowlist may not name a file that is pulling its weight, or one
  // that does not exist — either way the reason is stale and misleading.
  for (const [spec, reason] of Object.entries(skipAllowlist)) {
    if (!registeredSpecs.includes(spec)) {
      findings.push(
        `SKIP_ALLOWLIST names "${spec}" ("${reason}"), which is not a registered spec. ` +
          `Remove it — a stale exemption silently covers for the next file to go quiet.`,
      );
    } else if (filesParticipating.includes(spec)) {
      findings.push(
        `SKIP_ALLOWLIST exempts "${spec}" ("${reason}") but it ran tests. Drop the ` +
          `exemption so the file is guarded again.`,
      );
    }
  }

  // 3 — every ledger claim on this tier was actually proved by a PASSING test.
  for (const surface of claimedSurfaces) {
    if ([...provedBy.keys()].some((a) => annotationProves(a, surface))) continue;
    findings.push(
      `the ledger claims "${surface}" is effect-verified on this tier, but no PASSING ` +
        `test annotated it. Add \`test.info().annotations.push({ type: "surface", ` +
        `description: "${surface}" })\` to the test that proves it — or set its ` +
        `evidence back to "pending" in docs/surfaces/effect-coverage.json. A claim ` +
        `nothing runs is worse than no claim.`,
    );
  }

  // 4 — the inverse: a passing test proved something the ledger still calls
  // pending, or misspelled. Under-claiming rots a ledger as surely as
  // over-claiming, and a typo'd annotation is invisible without this.
  for (const annotation of provedBy.keys()) {
    if (knownSurfaces.some((s) => annotationProves(annotation, s))) {
      if (claimedSurfaces.some((s) => annotationProves(annotation, s))) continue;
      findings.push(
        `a passing test annotated "${annotation}" but the ledger still records that ` +
          `surface as evidence:"pending". Flip it in the same PR that adds the test — ` +
          `that is the whole point of landing the ledger first.`,
      );
      continue;
    }
    findings.push(
      `annotation "${annotation}" matches no surface in the ledger. Check the spelling ` +
        `against docs/surfaces/effect-coverage.json; an annotation nothing reads is a ` +
        `test that silently proves nothing to the guard.`,
    );
  }

  // The guard only ever turns green into red. A run Playwright already failed
  // has its own, better diagnostics; piling on cascade findings (a serial
  // describe skips everything after a failure, so checks 2-4 all fire) would
  // bury them. Findings are still reported — they just do not decide anything.
  const alreadyFailed = runStatus !== "passed";

  return {
    ok: findings.length === 0,
    findings,
    shouldFail: findings.length > 0 && !alreadyFailed,
    summary: {
      total: records.length,
      ran: ran.length,
      passed: passed.length,
      skipped: records.length - ran.length,
      retried: records.filter((r) => r.retry > 0).length,
      filesParticipating,
      surfacesProved: [...provedBy.keys()].sort(),
    },
  };
}
