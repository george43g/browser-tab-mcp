/** Types for verify-release.mjs (plain ESM so the CLI and the tests share one file). */

export interface ReleaseFacts {
  /** Tag the `.release-please-manifest.json` baseline implies, e.g. `v1.1.1`. */
  expectedTag: string;
  /** Does the repo have any release tag at all (false = never released). */
  anyTagsExist: boolean;
  /** Does `expectedTag` exist on the remote. */
  tagExists: boolean;
  /** Is there a published GitHub Release for it; `null` = could not determine. */
  releaseExists: boolean | null;
  /**
   * Merged release PRs whose version has NO tag; `null` = could not determine.
   * A `autorelease: pending` label alone does not qualify — release-please tags
   * before it relabels, so the label lags a healthy release.
   */
  pendingMergedPrs: string[] | null;
  /** Paths `release-please-config.json` lists as `extra-files`. */
  extraFiles?: string[];
  /** The open release PR and the paths its diff touches; `null` = none open / unknown. */
  openReleasePr?: { number: number; files: string[] } | null;
}

export interface ReleaseVerdict {
  ok: boolean;
  problems: string[];
  notes: string[];
}

export declare function verdict(facts: ReleaseFacts): ReleaseVerdict;

/**
 * Filter merged release PRs down to those genuinely untagged. Exported for
 * testing the label-vs-tag race directly.
 */
export declare function untaggedPending(
  prs: { number: number; title: string }[],
  isTagged: (version: string) => boolean,
): string[];
