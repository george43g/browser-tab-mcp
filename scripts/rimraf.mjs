#!/usr/bin/env node
/**
 * `rm -rf`, portably.
 *
 * Every `clean` script in the workspace shelled out to `rm -rf`, which does not
 * exist on Windows. `fs.rmSync` is the same operation with no shell at all, and
 * it is already what Node uses under the hood everywhere else.
 *
 * Usage: node scripts/rimraf.mjs <path> [...paths]
 */

import { rmSync } from "node:fs";

for (const target of process.argv.slice(2)) {
  rmSync(target, { recursive: true, force: true });
}
