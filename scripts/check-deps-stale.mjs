#!/usr/bin/env node
/**
 * Are we starved of a dependency we think we're tracking?
 *
 * WHY THIS EXISTS. Three times now this repo has sat on a stale kit without
 * anything going red, and each time an OUTSIDE session found it, not us:
 *
 *   - `@george43g/robustness` sat three minors behind in TWO manifests (the
 *     app and the vendored `packages/mcp-kit` — the second one nobody greps).
 *   - `@george43g/cli-kit` had a lockfile pinned BELOW what its own specifier
 *     admitted, so a manifest grep said "up to date" and the running code
 *     wasn't.
 *   - `^0.11.0` could not reach `robustness@0.12.0`, which is where email
 *     redaction shipped — a privacy feature that was not merely off but
 *     absent from the code we run. Found 2026-08-23, by the dotfiles session.
 *
 * The through-line is that **a manifest specifier is not evidence of what
 * runs**. This script reads the RESOLVED version out of `node_modules` and
 * compares three things that can disagree: what the manifest asks for, what is
 * installed, and what the registry has.
 *
 * SEMVER SCOPE, DELIBERATELY NARROW. Every non-workspace specifier in this
 * repo today is a caret (62 of them; verified 2026-08-23). So this handles `^`
 * and exact pins, and REPORTS anything else as unparsed rather than guessing.
 * A half-right range parser that silently mis-reads one specifier is worse
 * than one that admits it doesn't know — the whole point here is to stop
 * trusting a reading that looks fine.
 *
 * Usage:
 *   node scripts/check-deps-stale.mjs              offline: structural + install integrity
 *   node scripts/check-deps-stale.mjs --registry   also ask npm what's published
 *   node scripts/check-deps-stale.mjs --registry --advisory   never exit non-zero on staleness
 *   node scripts/check-deps-stale.mjs --filter @george43g     only these packages
 *   node scripts/check-deps-stale.mjs --all        list the collapsed MAJOR-BEHIND rows
 *   node scripts/check-deps-stale.mjs --root DIR   scan a fixture tree (tests)
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const argvRaw = process.argv.slice(2);
const rootIdx = argvRaw.indexOf("--root");
/**
 * `--root` exists so the test suite can point this at a fixture tree instead
 * of the real workspace. A script whose only exercise is "we ran it once and
 * it looked right" is the shape this repo keeps getting burned by.
 */
const ROOT =
  rootIdx >= 0 && argvRaw[rootIdx + 1]
    ? resolve(argvRaw[rootIdx + 1])
    : resolve(dirname(fileURLToPath(import.meta.url)), "..");

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const OFF = "\x1b[0m";

const argv = argvRaw;
const useRegistry = argv.includes("--registry");
const advisory = argv.includes("--advisory");
const showAll = argv.includes("--all");
const filterIdx = argv.indexOf("--filter");
const filter = filterIdx >= 0 ? argv[filterIdx + 1] : null;

// ── semver, only as much as this repo actually uses ───────────────────────

/** `"1.2.3"` → `[1,2,3]`; null for anything with a prerelease or junk. */
function parseVersion(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(v).trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

/**
 * The half-open range a specifier admits, as `{ floor, ceiling }` — or null
 * when we don't recognise the shape.
 *
 * Caret on a 0.x is the whole reason this file exists: `^0.11.0` is
 * `>=0.11.0 <0.12.0`, NOT `<1.0.0`. On a 0.x package the minor IS the breaking
 * slot, so a caret pins you to one minor and no `pnpm install` will ever move
 * you off it. `^0.0.z` is tighter still — it admits exactly one version.
 */
function caretRange(spec) {
  const s = String(spec).trim();
  const exact = parseVersion(s);
  if (exact) return { floor: exact, ceiling: null, kind: "exact" };
  if (!s.startsWith("^")) return null;
  const floor = parseVersion(s.slice(1));
  if (!floor) return null;
  const [major, minor, patch] = floor;
  if (major > 0) return { floor, ceiling: [major + 1, 0, 0], kind: "caret-major" };
  if (minor > 0) return { floor, ceiling: [0, minor + 1, 0], kind: "caret-minor" };
  return { floor, ceiling: [0, 0, patch + 1], kind: "caret-patch" };
}

const show = (v) => (v ? v.join(".") : "—");

// ── inputs ────────────────────────────────────────────────────────────────

function manifestPaths() {
  const out = [join(ROOT, "package.json")];
  for (const group of ["apps", "packages"]) {
    const dir = join(ROOT, group);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const p = join(dir, group === "apps" || group === "packages" ? name : name, "package.json");
      if (existsSync(p)) out.push(p);
    }
  }
  return out;
}

/**
 * What is ACTUALLY installed, read from the resolved package's own manifest.
 *
 * Not the lockfile: a lockfile is a plan, `node_modules` is the outcome, and
 * the gap between them is one of the three shapes this script exists to catch.
 * pnpm's layout means the resolution differs per workspace package, so resolve
 * from the consuming manifest's own directory.
 */
function resolvedVersion(fromDir, name) {
  let dir = fromDir;
  for (;;) {
    const candidate = join(dir, "node_modules", name, "package.json");
    if (existsSync(candidate)) {
      try {
        return JSON.parse(readFileSync(candidate, "utf8")).version ?? null;
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const registryCache = new Map();
function registryLatest(name) {
  if (registryCache.has(name)) return registryCache.get(name);
  let latest = null;
  try {
    latest = execFileSync("npm", ["view", name, "dist-tags.latest"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 20_000,
    }).trim();
  } catch {
    latest = null; // unpublished, private, or the network is down — all "unknown"
  }
  registryCache.set(name, latest || null);
  return latest || null;
}

// ── the scan ──────────────────────────────────────────────────────────────

const findings = [];
const unparsed = [];
let scanned = 0;

for (const manifestPath of manifestPaths()) {
  const rel = manifestPath.slice(ROOT.length + 1);
  const pkgDir = dirname(manifestPath);
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    continue;
  }

  for (const section of ["dependencies", "devDependencies"]) {
    for (const [name, spec] of Object.entries(pkg[section] ?? {})) {
      // A workspace link has no upstream to be behind.
      if (String(spec).startsWith("workspace:") || String(spec).startsWith("link:")) continue;
      if (filter && !name.includes(filter)) continue;
      scanned++;

      const range = caretRange(spec);
      if (!range) {
        unparsed.push({ rel, name, spec });
        continue;
      }

      const resolvedRaw = resolvedVersion(pkgDir, name);
      const resolved = resolvedRaw ? parseVersion(resolvedRaw) : null;

      if (!resolvedRaw) {
        findings.push({
          level: "error",
          code: "NOT-INSTALLED",
          rel,
          name,
          spec,
          detail: "no resolved copy under node_modules — run `pnpm install`",
        });
        continue;
      }

      // Integrity: installed below the floor the manifest demands. Offline,
      // deterministic, and always a real defect.
      if (resolved && cmp(resolved, range.floor) < 0) {
        findings.push({
          level: "error",
          code: "BELOW-FLOOR",
          rel,
          name,
          spec,
          detail: `resolved ${resolvedRaw} is BELOW the specifier floor ${show(range.floor)}`,
        });
        continue;
      }

      if (!useRegistry) continue;

      const latestRaw = registryLatest(name);
      const latest = latestRaw ? parseVersion(latestRaw) : null;
      if (!latest || !resolved) continue;
      if (cmp(latest, resolved) <= 0) continue;

      // Published version exists that we don't run. Which of the two shapes?
      const admitted = !range.ceiling || cmp(latest, range.ceiling) < 0;
      if (admitted) {
        // The specifier WOULD take it; the install has not. A lockfile that
        // satisfies a range never floats off it on its own.
        findings.push({
          level: "warn",
          code: "LOCK-STALE",
          rel,
          name,
          spec,
          detail: `running ${resolvedRaw}, registry has ${latestRaw}, and "${spec}" admits it — \`pnpm update ${name}\``,
        });
      } else if (range.kind === "caret-major") {
        // A caret on a 1.x+ package capping below a new MAJOR is the ordinary,
        // deliberate state of nearly every dependency everywhere. Reporting it
        // as a defect is how a tool like this trains you to ignore it — and
        // then the one row that matters scrolls past unread. Informational,
        // never blocking, collapsed unless --all.
        findings.push({
          level: "info",
          code: "MAJOR-BEHIND",
          rel,
          name,
          spec,
          detail: `running ${resolvedRaw}, registry has ${latestRaw} (next major); "${spec}" caps at <${show(range.ceiling)}`,
        });
      } else {
        // A caret on a 0.x package. THIS is the one worth waking up for: on
        // 0.x the MINOR is semver's breaking slot, so `^0.11.0` caps at
        // <0.12.0 and no install will ever cross it. It reads like an ordinary
        // caret and behaves like an exact pin. Three real instances so far,
        // the last of which hid a privacy feature — see this file's header.
        findings.push({
          level: "error",
          code: "STARVED",
          rel,
          name,
          spec,
          detail:
            `running ${resolvedRaw}, registry has ${latestRaw}, but "${spec}" caps at ` +
            `<${show(range.ceiling)} — a 0.x caret pins the MINOR, so no \`pnpm install\` ` +
            `can reach it; raise the specifier`,
        });
      }
    }
  }
}

// ── report ────────────────────────────────────────────────────────────────

const bySeverity = { error: [], warn: [], info: [] };
for (const f of findings) bySeverity[f.level].push(f);

process.stdout.write(
  `\n${BOLD}dependency freshness${OFF} ${DIM}— ${scanned} external specifiers across ` +
    `${manifestPaths().length} manifests${useRegistry ? ", registry consulted" : ", offline"}${OFF}\n\n`,
);

for (const level of ["error", "warn"]) {
  for (const f of bySeverity[level]) {
    const tag = level === "error" ? `${RED}${f.code}${OFF}` : `${YELLOW}${f.code}${OFF}`;
    process.stdout.write(`  ${tag} ${BOLD}${f.name}${OFF} ${DIM}(${f.rel})${OFF}\n`);
    process.stdout.write(`      ${f.detail}\n`);
  }
}

// Collapsed by default. A wall of ordinary major-behind rows is exactly what
// makes a report like this stop being read.
if (bySeverity.info.length) {
  if (showAll) {
    for (const f of bySeverity.info) {
      process.stdout.write(`  ${DIM}${f.code} ${f.name} (${f.rel})${OFF}\n`);
      process.stdout.write(`      ${DIM}${f.detail}${OFF}\n`);
    }
  } else {
    const names = [...new Set(bySeverity.info.map((f) => f.name))];
    process.stdout.write(
      `  ${DIM}MAJOR-BEHIND ${bySeverity.info.length} specifier(s) across ${names.length} ` +
        `package(s) sit behind a new major — ordinary and deliberate. --all to list.${OFF}\n`,
    );
  }
}

if (unparsed.length) {
  process.stdout.write(
    `\n  ${YELLOW}UNPARSED${OFF} ${unparsed.length} specifier(s) this script does not model — ` +
      `reported, never guessed:\n`,
  );
  for (const u of unparsed) {
    process.stdout.write(`      ${u.name}@${u.spec} ${DIM}(${u.rel})${OFF}\n`);
  }
}

if (!useRegistry) {
  process.stdout.write(
    `\n${DIM}Offline run: checked install integrity only. Staleness needs the registry —\n` +
      `re-run with --registry to find caret-starved and lockfile-stale deps.${OFF}\n`,
  );
}

const errors = bySeverity.error.length;
const warns = bySeverity.warn.length;
if (!errors && !warns && !unparsed.length && !bySeverity.info.length) {
  process.stdout.write(`${GREEN}✓${OFF} nothing stale, nothing starved, nothing unreadable.\n`);
}
process.stdout.write("\n");

if (errors && !advisory) {
  process.stdout.write(`${RED}${errors} blocking finding(s).${OFF}\n\n`);
  process.exit(1);
}
process.exit(0);
