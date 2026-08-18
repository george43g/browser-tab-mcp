#!/usr/bin/env node
/**
 * Build every extension entry, one Vite pass each.
 *
 * The entries CANNOT share a pass: Safari loads the background as a classic
 * script, so each one is bundled fully inlined (`format: "iife"`,
 * `inlineDynamicImports`) and Vite does that per build. The entry is selected
 * by the `EXT_ENTRY` env var.
 *
 * WHY THIS IS NOT `EXT_ENTRY=background vite build && …` ANY MORE. The
 * `VAR=value command` prefix is POSIX-only; under `cmd.exe` it is a syntax
 * error, so the extension could not be built on Windows — where the extension
 * itself runs perfectly well (the user verified it installs in Windows Chrome).
 */

import { spawnSync } from "node:child_process";

const ENTRIES = ["background", "options", "popup", "extract"];

for (const entry of ENTRIES) {
  const r = spawnSync("vite", ["build"], {
    stdio: "inherit",
    shell: true,
    env: { ...process.env, EXT_ENTRY: entry },
  });
  if (r.status !== 0) {
    process.stderr.write(`\nextension build failed on entry "${entry}"\n`);
    process.exit(r.status ?? 1);
  }
}
