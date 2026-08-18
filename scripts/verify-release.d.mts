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
  /** Merged PRs still labelled `autorelease: pending`; `null` = could not determine. */
  pendingMergedPrs: string[] | null;
}

export interface ReleaseVerdict {
  ok: boolean;
  problems: string[];
  notes: string[];
}

export declare function verdict(facts: ReleaseFacts): ReleaseVerdict;
