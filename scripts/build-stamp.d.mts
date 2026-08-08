/** Types for build-stamp.mjs (plain ESM so both vite.config.ts files can import it). */

/** `<semver>+<count>.<sha>[.dirty.<MMDDTHHmm>]` */
export declare function buildStamp(version: string): string;

/** The Vite `define` block both bundles share. */
export declare function buildDefines(version: string): {
  __BUILD_STAMP__: string;
  __BUILT_AT__: string;
};
