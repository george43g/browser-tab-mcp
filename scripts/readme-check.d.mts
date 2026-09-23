/** Types for readme-check.mjs (plain ESM so the workflow and the tests share one file). */

export interface ReadmeGap {
  /** The README that should have changed, repo-relative. */
  readme: string;
  /** The changed source files it covers. */
  sources: string[];
}

/** The README nearest up-tree from a repo-relative path, falling back to the root README. */
export declare function nearestReadme(path: string, root?: string): string;

/** READMEs that cover changed `apps/*` / `packages/*` source but were not changed themselves. */
export declare function readmeGaps(changed: readonly string[], root?: string): ReadmeGap[];
