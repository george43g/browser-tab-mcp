/** Types for check-usage-freshness.mjs (plain ESM so the CLI and the tests share one file). */

/**
 * What to do about one artifact given whether its checked-in copy exists and
 * whether the repo has locked a baseline (ANY checked-in artifact exists).
 * "compare" byte-compares; "soft-pass" hints and passes (scaffold state);
 * "fail" treats the absence as a deletion (B21 audit, 2026-09-02).
 */
export declare function missingPolicy(
  checkedInExists: boolean,
  baselineLocked: boolean,
): "compare" | "soft-pass" | "fail";
