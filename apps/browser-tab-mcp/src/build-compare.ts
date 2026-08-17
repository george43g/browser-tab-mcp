/**
 * Build-stamp comparison.
 *
 * The logic MOVED to `@george43g/shared-types` so the browser extension can use
 * the same comparison the daemon does — extension-core cannot import app code,
 * and hand-copying `commitOf` into it would be five lines free to drift apart
 * from the five lines `doctor` trusts. Re-exported here so every existing
 * import path (and this module's test) keeps working.
 */

export { type BuildComparison, commitOf, compareBuilds } from "@george43g/shared-types";
