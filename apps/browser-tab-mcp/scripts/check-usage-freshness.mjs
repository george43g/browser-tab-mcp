#!/usr/bin/env node
// Fail CI if the checked-in completions / manpage / CLI docs are stale
// relative to .usage.kdl. Regenerates artifacts into a tempdir and
// byte-compares against the checked-in copies under completions/, man/,
// and docs/cli/.
//
// Usage: node scripts/check-usage-freshness.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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

function regen(tmp) {
  // CWD into APP_DIR so usage(1) emits the SAME byte-content as when run
  // via `mise run completions` (which is also cwd=APP_DIR). usage embeds
  // the resolved .usage.kdl path in some outputs — passing an absolute
  // path here would silently drift vs the checked-in artifacts.
  execFileSync(
    "bash",
    [
      "-c",
      `set -e
       usage g completion bash ${BIN} -f .usage.kdl > ${tmp}/${BIN}.bash
       usage g completion zsh  ${BIN} -f .usage.kdl > ${tmp}/_${BIN}
       usage g completion fish ${BIN} -f .usage.kdl > ${tmp}/${BIN}.fish
       usage g manpage -f .usage.kdl -o ${tmp}/${BIN}.1
       mkdir -p ${tmp}/docs-cli
       usage g markdown -f .usage.kdl -m --out-dir ${tmp}/docs-cli/`,
    ],
    { cwd: APP_DIR },
  );
}

function checkOne(label, fresh, checkedIn) {
  if (!fileExists(checkedIn)) {
    // Not-yet-generated is a soft state (first-run after scaffold).
    // Print a hint but don't fail — the user runs `pnpm artifacts` and
    // commits to lock the baseline. Drift detection kicks in once the
    // file lands in the repo.
    console.log(`· ${label}: not yet generated (run: pnpm artifacts)`);
    return true;
  }
  const a = readFileSync(fresh);
  const b = readFileSync(checkedIn);
  if (!a.equals(b)) {
    console.error(`✗ ${label}: ${checkedIn} drifted from .usage.kdl (regenerate: pnpm artifacts)`);
    return false;
  }
  return true;
}

function fileExists(p) {
  try {
    statSync(p);
    return true;
  } catch {
    return false;
  }
}

const tmp = mkdtempSync(join(tmpdir(), "usage-freshness-"));
regen(tmp);

let ok = true;
ok =
  checkOne(
    "bash completion",
    join(tmp, `${BIN}.bash`),
    join(APP_DIR, "completions", `${BIN}.bash`),
  ) && ok;
ok =
  checkOne("zsh completion", join(tmp, `_${BIN}`), join(APP_DIR, "completions", `_${BIN}`)) && ok;
ok =
  checkOne(
    "fish completion",
    join(tmp, `${BIN}.fish`),
    join(APP_DIR, "completions", `${BIN}.fish`),
  ) && ok;
ok = checkOne("manpage", join(tmp, `${BIN}.1`), join(APP_DIR, "man", `${BIN}.1`)) && ok;

// docs/cli/ is a directory of N markdown files — compare contents per file.
const docsTmp = join(tmp, "docs-cli");
const docsCheckedIn = join(APP_DIR, "docs", "cli");
if (fileExists(docsTmp) && fileExists(docsCheckedIn)) {
  const fresh = new Set(readdirSync(docsTmp).filter((f) => f.endsWith(".md")));
  const onDisk = new Set(readdirSync(docsCheckedIn).filter((f) => f.endsWith(".md")));
  if (fresh.size !== onDisk.size || ![...fresh].every((f) => onDisk.has(f))) {
    console.error("✗ docs/cli/ filename set drifted (regenerate: pnpm docs:cli)");
    ok = false;
  } else {
    for (const f of fresh) {
      ok = checkOne(`docs/cli/${f}`, join(docsTmp, f), join(docsCheckedIn, f)) && ok;
    }
  }
} else if (fileExists(docsCheckedIn)) {
  console.error("✗ docs/cli/ exists on disk but regen produced nothing");
  ok = false;
}

if (!ok) {
  console.error("\n→ Fix: pnpm artifacts && git add completions/ man/ docs/cli/");
  process.exit(1);
}
console.log("✓ usage(1) artifacts are fresh");
