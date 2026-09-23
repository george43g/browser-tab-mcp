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
  /**
   * Did `git ls-remote --tags origin` actually answer (default true). False
   * fails the verdict outright: an unreadable remote must not impersonate a
   * never-released repo (B21 audit, 2026-09-02).
   */
  tagsReadable?: boolean;
  /**
   * Is the `gh` binary runnable (default false). With it true, a `null`
   * releaseExists/pendingMergedPrs is a FAILED check rather than an absent
   * tool, and the verdict goes red instead of noting "gh unavailable".
   */
  ghPresent?: boolean;
  /** gh was present but the open-release-PR list query failed (default false). */
  openPrQueryFailed?: boolean;
  /** This line's release-please branch, named in the recovery hint. */
  branch?: string;
}

/** One release-please package, as the verify job sees it. */
export interface ReleaseLine {
  /** Package path in release-please-config.json (`.` for the root line). */
  path: string;
  /** Component: explicit `component`, else the package.json name without its scope. */
  component: string;
  /** Does the tag carry the component (`<component>-v1.2.3`) or not (`v1.2.3`). */
  withComponent: boolean;
  /** Manifest version (`0.0.0` when the manifest has no entry). */
  version: string;
  tagPrefix: string;
  expectedTag: string;
  branch: string;
  extraFiles: string[];
}

export declare function releaseLines(
  config: Record<string, any>,
  manifest: Record<string, string>,
  packageName: (path: string) => string | undefined,
): ReleaseLine[];

/** The line a release PR title's component names (null = the component-less line). */
export declare function lineForComponent(
  lines: ReleaseLine[],
  component: string | null,
): ReleaseLine | undefined;

/** Tag names out of `git ls-remote --tags` output. */
export declare function parseRemoteTags(raw: string): Set<string>;

/** One line's facts from what the remote and gh reported. */
export declare function lineFacts(
  line: ReleaseLine,
  observed: {
    tags: Set<string>;
    tagsReadable: boolean;
    ghPresent: boolean;
    releaseExists: boolean | null;
    openReleasePr: { number: number; files: string[] } | null;
    openPrQueryFailed: boolean;
    pendingMergedPrs: string[] | null;
  },
): ReleaseFacts;

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
  isTagged: (version: string, component: string | null) => boolean,
): string[];
