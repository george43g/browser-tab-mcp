#!/usr/bin/env node
// Fail CI if the checked-in completions / manpage / CLI docs are stale
// relative to .usage.kdl. Regenerates artifacts into a tempdir and
// byte-compares against the checked-in copies under completions/, man/,
// and docs/cli/.
//
// Usage: node scripts/check-usage-freshness.mjs
//
// usage(1) output differs between versions, so the regeneration must run the
// version pinned in mise.toml — the one `pnpm artifacts` (`mise run
// artifacts`) used to write the baseline. Running whatever `usage` is first on
// PATH reported every artifact as drifted on a machine with a global
// `usage@latest`. See resolveUsage() below (synced from mcp-cli-starter-template #133).

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(__dirname, "..");
const USAGE_KDL = join(APP_DIR, ".usage.kdl");

// --- usage(1) resolver: begin -------------------------------------------------
// In mcp-cli-starter-template, the repo that scaffolds this script, the same
// region guards the scaffolder's own artifacts; its
// apps/scaffolder/tests/usage-resolver-twin.test.ts keeps the copies identical.

/**
 * The `usage` pin that governs `dir`: the nearest mise.toml / .mise.toml at or
 * above it whose [tools] table names usage — nearest wins, as it does for mise
 * itself. Returns { version, file } or null when nothing pins it.
 */
function findUsagePin(dir) {
  let current = resolve(dir);
  for (;;) {
    for (const name of ["mise.toml", ".mise.toml"]) {
      const file = join(current, name);
      if (!existsSync(file)) continue;
      const version = readUsagePin(readFileSync(file, "utf8"));
      if (version) return { version, file };
    }
    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/** `usage = "x"` or `usage = { version = "x" }` inside [tools]; else null. */
function readUsagePin(toml) {
  let inTools = false;
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "").trim();
    const table = line.match(/^\[([^\]]+)\]$/);
    if (table) {
      inTools = table[1].trim() === "tools";
      continue;
    }
    if (!inTools) continue;
    const entry = line.match(/^"?usage"?\s*=\s*(.+)$/);
    if (!entry) continue;
    const value = entry[1];
    const plain = value.match(/^"([^"]+)"$/);
    if (plain) return plain[1];
    const inline = value.match(/version\s*=\s*"([^"]+)"/);
    if (inline) return inline[1];
  }
  return null;
}

/** "usage-cli 3.3.0" → "3.3.0"; null when the output carries no version. */
function parseUsageVersion(output) {
  return output.match(/(\d+\.\d+\.\d+[^\s]*)/)?.[1] ?? null;
}

/** A pin of "3.3.0" matches only 3.3.0; "3.3" or "3" match as a prefix. */
function versionMatchesPin(version, pin) {
  return version === pin || version.startsWith(`${pin}.`);
}

/**
 * Spawn a bare command name. On Windows, mise and usage may be .cmd shims,
 * which spawn only resolves through a shell — so there it goes through cmd.exe
 * as ONE command string (not shell:true plus an args array, which Node 24
 * deprecates as DEP0190). Every argument here is a fixed word or a version
 * string read from mise.toml, never user input.
 */
function run(cmd, args, cwd) {
  const opts = { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] };
  const result =
    process.platform === "win32"
      ? spawnSync([cmd, ...args.map((a) => (/^[\w@/.:=,+-]+$/.test(a) ? a : `"${a}"`))].join(" "), {
          ...opts,
          shell: true,
        })
      : spawnSync(cmd, args, opts);
  const ok = !result.error && result.status === 0;
  const detail = result.error
    ? (result.error.code ?? result.error.message)
    : `${result.stderr ?? ""}${result.stdout ?? ""}`.trim().split(/\r?\n/).slice(-3).join(" | ");
  return { ok, stdout: (result.stdout ?? "").trim(), detail };
}

/**
 * Which usage(1) binary to regenerate with. Never guesses: it returns the
 * pinned binary, or exits 2 with both versions and the fix. It never returns a
 * binary whose version differs from the pin, because every byte of the
 * comparison would then be a false drift.
 *
 * 1. mise on PATH: install (a no-op when present) and locate usage@<pin>
 *    explicitly, from a neutral cwd so an untrusted project config cannot
 *    block it. PATH order and any global `mise use usage@latest` are
 *    irrelevant to the result.
 * 2. No mise, or mise failed: `usage` from PATH, accepted only if its
 *    --version matches the pin.
 * 3. No pin anywhere: `usage` from PATH, with a warning that drift reports are
 *    only as good as that version.
 */
function resolveUsage(dir) {
  const pin = findUsagePin(dir);
  if (!pin) {
    console.warn(
      "! No usage version pinned in any mise.toml at or above this app; using usage from PATH.\n" +
        '  A different usage version reports every artifact as drifted — pin one: [tools] usage = "<version>"',
    );
    return "usage";
  }

  let miseFailure = null;
  const neutral = tmpdir();
  const miseVersion = run("mise", ["--version"], neutral);
  if (miseVersion.ok) {
    const install = run("mise", ["install", `usage@${pin.version}`], neutral);
    const which = install.ok
      ? run("mise", ["which", "usage", "--tool", `usage@${pin.version}`], neutral)
      : install;
    if (which.ok && which.stdout) {
      const bin = which.stdout.split(/\r?\n/).pop().trim();
      const got = run(bin, ["--version"], neutral);
      const version = got.ok ? parseUsageVersion(got.stdout) : null;
      if (version && versionMatchesPin(version, pin.version)) return bin;
      miseFailure = `mise resolved ${bin}, which reports ${version ?? `no version (${got.detail})`}`;
    } else {
      miseFailure = `mise could not provide usage@${pin.version}: ${which.detail}`;
    }
  }

  const onPath = run("usage", ["--version"], neutral);
  const pathVersion = onPath.ok ? parseUsageVersion(onPath.stdout) : null;
  if (pathVersion && versionMatchesPin(pathVersion, pin.version)) return "usage";

  const found = onPath.ok
    ? `usage on PATH is ${pathVersion ?? `unrecognised ("${onPath.stdout}")`}`
    : `no usage on PATH (${onPath.detail})`;
  console.error(
    `✗ usage(1) version mismatch — not checking artifacts, every comparison would be a false drift.\n` +
      `  pinned: ${pin.version} (${pin.file})\n` +
      `  found:  ${found}\n` +
      (miseFailure ? `  mise:   ${miseFailure}\n` : "  mise:   not on PATH\n") +
      `  Fix: install mise (https://mise.jdx.dev) and run \`mise install\`, or put usage ${pin.version} first on PATH.`,
  );
  process.exit(2);
}
// --- usage(1) resolver: end ---------------------------------------------------

// Read the bin name from .usage.kdl (`bin "<name>"`) so this script works
// for any cloned tool without hard-coding tmux-control.
const usageSrc = readFileSync(USAGE_KDL, "utf8");
const binMatch = usageSrc.match(/^bin\s+"([^"]+)"/m);
if (!binMatch) {
  console.error(`✗ Couldn't find \`bin "..."\` in ${USAGE_KDL}`);
  process.exit(2);
}
const BIN = binMatch[1];
const USAGE = resolveUsage(APP_DIR);

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
       "$USAGE_BIN" g completion bash ${BIN} -f .usage.kdl > ${tmp}/${BIN}.bash
       "$USAGE_BIN" g completion zsh  ${BIN} -f .usage.kdl > ${tmp}/_${BIN}
       "$USAGE_BIN" g completion fish ${BIN} -f .usage.kdl > ${tmp}/${BIN}.fish
       "$USAGE_BIN" g manpage -f .usage.kdl -o ${tmp}/${BIN}.1
       mkdir -p ${tmp}/docs-cli
       "$USAGE_BIN" g markdown -f .usage.kdl -m --out-dir ${tmp}/docs-cli/`,
    ],
    { cwd: APP_DIR, env: { ...process.env, USAGE_BIN: USAGE } },
  );
}

function checkOne(label, fresh, checkedIn) {
  if (!fileExists(checkedIn)) {
    console.error(`✗ ${label}: missing ${checkedIn} (generate: pnpm artifacts)`);
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
} else {
  console.error("✗ docs/cli/ baseline is missing or regeneration produced nothing");
  ok = false;
}

rmSync(tmp, { recursive: true, force: true });

if (!ok) {
  console.error("\n→ Fix: pnpm artifacts && git add completions/ man/ docs/cli/");
  process.exit(1);
}
console.log("✓ usage(1) artifacts are fresh");
