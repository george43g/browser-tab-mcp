/** Types for deploy-scope.mjs (plain ESM so the post-merge hook and the tests share one file). */

/** The apps a browser-tab deploy (scripts/deploy-local.mjs) builds, restarts or reloads. */
export declare const DEPLOY_ROOTS: readonly string[];

/**
 * Repo-relative directories whose change must redeploy browser-tab: the
 * deploy roots plus every workspace package they depend on, transitively.
 */
export declare function deployScope(root?: string): Set<string>;

/** Does this set of changed repo-relative paths need a browser-tab deploy? */
export declare function needsBrowserTabDeploy(paths: readonly string[], root?: string): boolean;
