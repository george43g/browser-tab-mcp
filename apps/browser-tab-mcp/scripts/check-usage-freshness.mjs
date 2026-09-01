#!/usr/bin/env node
// Fail CI if the checked-in completions / manpage / CLI docs are stale
// relative to .usage.kdl. Regenerates artifacts into a tempdir and
// byte-compares against the checked-in copies under completions/, man/,
// and docs/cli/.
//
// Usage: node scripts/check-usage-freshness.mjs
//
// MISSING-FILE POLICY (B21 audit, 2026-09-02). "Checked-in copy missing" has
// two very different meanings and used to be treated as one: on a freshly
// scaffolded clone of the template no artifact exists yet, and soft-passing
// with a hint is right; but in a repo that has already locked its baseline —
// any artifact committed — a missing file means someone DELETED it, and
// soft-passing there turns the drift gate off exactly when it should fire
// (the partition-vs-iterate class: an empty match on the checked-in side
// moved the file to the benign "scaffold-fresh" side). `missingPolicy` is
// exported and unit-tested (tests/usage-freshness-policy.test.ts) so the
// selector itself stays pinned.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * What to do about one artifact given whether its checked-in copy exists and
 * whether the repo has locked a baseline (ANY checked-in artifact exists).
 * Pure, exported for the unit test.
 *
 * @param {boolean} checkedInExists
 * @param {boolean} baselineLocked
 * @returns {"compare" | "soft-pass" | "fail"}
 */
export function missingPolicy(checkedInExists, baselineLocked) {
  if (checkedInExists) return "compare";
  return baselineLocked ? "fail" : "soft-pass";
}

function fileExists(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

function regen(tmp, appDir, bin) {
  // CWD into APP_DIR so usage(1) emits the SAME byte-content as when run
  // via `mise run completions` (which is also cwd=APP_DIR). usage embeds
  // the resolved .usage.kdl path in some outputs — passing an absolute
  // path here would silently drift vs the checked-in artifacts.
  execFileSync(
    "bash",
    [
      "-c",
      `set -e
       usage g completion bash ${bin} -f .usage.kdl > ${tmp}/${bin}.bash
       usage g completion zsh  ${bin} -f .usage.kdl > ${tmp}/_${bin}
       usage g completion fish ${bin} -f .usage.kdl > ${tmp}/${bin}.fish
       usage g manpage -f .usage.kdl -o ${tmp}/${bin}.1
       mkdir -p ${tmp}/docs-cli
       usage g markdown -f .usage.kdl -m --out-dir ${tmp}/docs-cli/`,
    ],
    { cwd: appDir },
  );
}

function checkOne(label, fresh, checkedIn, baselineLocked) {
  const policy = missingPolicy(fileExists(checkedIn), baselineLocked);
  if (policy === "soft-pass") {
    // True scaffold state: NO artifact has ever been committed. Print a hint
    // but don't fail — the user runs `pnpm artifacts` and commits to lock the
    // baseline. Drift detection kicks in once any file lands in the repo.
    console.log(`· ${label}: not yet generated (run: pnpm artifacts)`);
    return true;
  }
  if (policy === "fail") {
    console.error(
      `✗ ${label}: ${checkedIn} is missing while other usage artifacts are checked in — ` +
        `it was deleted, not never-generated (regenerate: pnpm artifacts)`,
    );
    return false;
  }
  const a = readFileSync(fresh);
  const b = readFileSync(checkedIn);
  if (!a.equals(b)) {
    console.error(`✗ ${label}: ${checkedIn} drifted from .usage.kdl (regenerate: pnpm artifacts)`);
    return false;
  }
  return true;
}

function main() {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const APP_DIR = resolve(__dirname, "..");
  const USAGE_KDL = join(APP_DIR, ".usage.kdl");

  // Read the bin name from .usage.kdl (`bin "<name>"`) so this script works
  // for any cloned tool without hard-coding browser-tab.
  const usageSrc = readFileSync(USAGE_KDL, "utf8");
  const binMatch = usageSrc.match(/^bin\s+"([^"]+)"/m);
  if (!binMatch) {
    console.error(`✗ Couldn't find \`bin "..."\` in ${USAGE_KDL}`);
    process.exit(2);
  }
  const BIN = binMatch[1];

  const tmp = mkdtempSync(join(tmpdir(), "usage-freshness-"));
  regen(tmp, APP_DIR, BIN);

  const targets = [
    ["bash completion", join(tmp, `${BIN}.bash`), join(APP_DIR, "completions", `${BIN}.bash`)],
    ["zsh completion", join(tmp, `_${BIN}`), join(APP_DIR, "completions", `_${BIN}`)],
    ["fish completion", join(tmp, `${BIN}.fish`), join(APP_DIR, "completions", `${BIN}.fish`)],
    ["manpage", join(tmp, `${BIN}.1`), join(APP_DIR, "man", `${BIN}.1`)],
  ];
  const docsCheckedIn = join(APP_DIR, "docs", "cli");
  // The baseline is locked the moment ANY artifact is committed — from then
  // on, absence is deletion.
  const baselineLocked =
    targets.some(([, , checkedIn]) => fileExists(checkedIn)) || fileExists(docsCheckedIn);

  let ok = true;
  for (const [label, fresh, checkedIn] of targets) {
    ok = checkOne(label, fresh, checkedIn, baselineLocked) && ok;
  }

  // docs/cli/ is a directory of N markdown files — compare contents per file.
  const docsTmp = join(tmp, "docs-cli");
  if (fileExists(docsTmp) && fileExists(docsCheckedIn)) {
    const fresh = new Set(readdirSync(docsTmp).filter((f) => f.endsWith(".md")));
    const onDisk = new Set(readdirSync(docsCheckedIn).filter((f) => f.endsWith(".md")));
    if (fresh.size !== onDisk.size || ![...fresh].every((f) => onDisk.has(f))) {
      console.error("✗ docs/cli/ filename set drifted (regenerate: pnpm docs:cli)");
      ok = false;
    } else {
      for (const f of fresh) {
        ok =
          checkOne(`docs/cli/${f}`, join(docsTmp, f), join(docsCheckedIn, f), baselineLocked) && ok;
      }
    }
  } else if (fileExists(docsCheckedIn)) {
    console.error("✗ docs/cli/ exists on disk but regen produced nothing");
    ok = false;
  } else if (missingPolicy(false, baselineLocked) === "fail") {
    // Other artifacts are committed but the docs/cli directory is gone —
    // deletion, same as a missing single file.
    console.error(
      "✗ docs/cli/ is missing while other usage artifacts are checked in (regenerate: pnpm docs:cli)",
    );
    ok = false;
  }

  if (!ok) {
    console.error("\n→ Fix: pnpm artifacts && git add completions/ man/ docs/cli/");
    process.exit(1);
  }
  console.log("✓ usage(1) artifacts are fresh");
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
