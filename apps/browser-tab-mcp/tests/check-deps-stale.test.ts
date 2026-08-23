/**
 * `scripts/check-deps-stale.mjs` classifies the three shapes it exists to catch.
 *
 * WHY THIS TEST IS NOT OPTIONAL. The script's whole purpose is to be trusted
 * when it says nothing is wrong. A dependency auditor that mis-classifies is
 * strictly worse than none, because it converts an unknown into a false
 * reassurance — which is the same failure this repo has now shipped five times
 * in other guises. "We ran it once on the real tree and it looked right" is not
 * evidence: the real tree exercises whichever shapes happen to be present today.
 *
 * So: a fixture workspace with each shape planted deliberately, and a fake
 * `npm` on PATH so the registry answer is fixed rather than whatever npm
 * happens to serve. Same PATH-shim technique as
 * `tests/build-rust-optional.test.ts`, for the same reason — manufacture the
 * world instead of waiting to encounter it.
 */

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCRIPT = join(REPO, "scripts", "check-deps-stale.mjs");
const isWin = process.platform === "win32";

const scratch: string[] = [];
afterAll(() => {
  for (const d of scratch) rmSync(d, { recursive: true, force: true });
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(d);
  return d;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Install `name@version` into `<dir>/node_modules` as far as this script cares. */
function installed(dir: string, name: string, version: string): void {
  writeJson(join(dir, "node_modules", name, "package.json"), { name, version });
}

/**
 * A fake `npm` that answers `npm view <name> dist-tags.latest` from a table.
 * Anything not in the table exits non-zero, which the script must read as
 * "unknown" rather than "up to date".
 */
function fakeNpm(latest: Record<string, string>): string {
  const dir = tmp("bt-fake-npm-");
  const table = Object.entries(latest)
    .map(([k, v]) => `  "${k}") echo "${v}" ;;`)
    .join("\n");
  if (isWin) {
    // `%1` is `view`, `%2` the package name. Each branch on its own lines so
    // `echo` cannot pick up a trailing space before the version — the script
    // trims, but a shim that emits subtly different bytes from the real tool
    // is a fixture that tests itself rather than the code.
    const lines = Object.entries(latest)
      .map(([k, v]) => `if "%2"=="${k}" (\r\n  echo ${v}\r\n  exit /b 0\r\n)`)
      .join("\r\n");
    writeFileSync(join(dir, "npm.cmd"), `@echo off\r\n${lines}\r\nexit /b 1\r\n`);
  } else {
    const p = join(dir, "npm");
    writeFileSync(p, `#!/bin/sh\ncase "$2" in\n${table}\n  *) exit 1 ;;\nesac\n`);
    chmodSync(p, 0o755);
  }
  return dir;
}

interface Run {
  stdout: string;
  code: number;
}

function run(root: string, args: string[], fakeNpmDir?: string): Run {
  const pathValue = fakeNpmDir
    ? `${fakeNpmDir}${isWin ? ";" : ":"}${process.env.PATH ?? ""}`
    : (process.env.PATH ?? "");
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: pathValue,
    ...(isWin ? { Path: pathValue, PATHEXT: ".COM;.EXE;.BAT;.CMD" } : {}),
    // Strip colour so assertions match on plain text.
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };
  try {
    const stdout = execFileSync("node", [SCRIPT, "--root", root, ...args], {
      encoding: "utf8",
      env,
    });
    return { stdout, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? "", code: e.status ?? 1 };
  }
}

/** A workspace with one package under `packages/`, plus its installed tree. */
function fixture(deps: Record<string, string>, resolved: Record<string, string>): string {
  const root = tmp("bt-deps-fixture-");
  writeJson(join(root, "package.json"), { name: "fixture-root", private: true });
  const pkgDir = join(root, "packages", "thing");
  writeJson(join(pkgDir, "package.json"), { name: "thing", dependencies: deps });
  for (const [name, version] of Object.entries(resolved)) installed(pkgDir, name, version);
  return root;
}

describe("check-deps-stale", () => {
  it("says nothing is wrong when nothing is (and exits 0)", () => {
    const root = fixture({ alpha: "^1.2.0" }, { alpha: "1.2.0" });
    const npm = fakeNpm({ alpha: "1.2.0" });
    const { stdout, code } = run(root, ["--registry"], npm);
    expect(code).toBe(0);
    expect(stdout).toContain("nothing stale, nothing starved");
  });

  // THE headline shape: a caret on a 0.x pins the MINOR, so no install can
  // ever cross it. This is the one that hid a privacy feature for a whole
  // release line and was found by an outside session, not by us.
  it("flags a 0.x caret that structurally cannot reach the latest (STARVED, blocking)", () => {
    const root = fixture({ kit: "^0.11.0" }, { kit: "0.11.0" });
    const npm = fakeNpm({ kit: "0.12.0" });
    const { stdout, code } = run(root, ["--registry"], npm);
    expect(stdout).toContain("STARVED");
    expect(stdout).toContain("kit");
    expect(stdout).toContain("caps at <0.12.0");
    expect(code, "a starved 0.x caret must be blocking, not advisory").toBe(1);
  });

  it("flags the 0.0.x sub-shape, where a caret admits exactly one version", () => {
    const root = fixture({ types: "^0.0.280" }, { types: "0.0.280" });
    const npm = fakeNpm({ types: "0.2.7" });
    const { stdout } = run(root, ["--registry"], npm);
    expect(stdout).toContain("STARVED");
    expect(stdout).toContain("caps at <0.0.281");
  });

  // The second shape: the range WOULD take the new version; the install has
  // not. A satisfying lockfile entry never floats off on its own.
  it("flags a resolution behind what its own specifier admits (LOCK-STALE, non-blocking)", () => {
    const root = fixture({ beta: "^2.1.0" }, { beta: "2.1.0" });
    const npm = fakeNpm({ beta: "2.4.0" });
    const { stdout, code } = run(root, ["--registry"], npm);
    expect(stdout).toContain("LOCK-STALE");
    expect(stdout).toContain("pnpm update beta");
    expect(code, "lock-stale is fixable by an install and must not block").toBe(0);
  });

  // The anti-crying-wolf rule. Nearly every dep everywhere is behind a major
  // on purpose; reporting that as a defect is how a report stops being read.
  it("does not treat an ordinary next-major as a defect", () => {
    const root = fixture({ gamma: "^5.7.0" }, { gamma: "5.9.3" });
    const npm = fakeNpm({ gamma: "7.0.2" });
    const { stdout, code } = run(root, ["--registry"], npm);
    expect(code).toBe(0);
    expect(stdout).not.toContain("STARVED");
    expect(stdout).toContain("MAJOR-BEHIND");
    // collapsed by default...
    expect(stdout).not.toContain("7.0.2");
    // ...and expandable, so the detail is available rather than lost.
    expect(run(root, ["--registry", "--all"], npm).stdout).toContain("7.0.2");
  });

  it("reports an install below the specifier floor, offline and without a registry", () => {
    const root = fixture({ delta: "^3.0.0" }, { delta: "2.9.9" });
    const { stdout, code } = run(root, []);
    expect(stdout).toContain("BELOW-FLOOR");
    expect(code).toBe(1);
  });

  it("reports a missing install rather than silently skipping it", () => {
    const root = fixture({ epsilon: "^1.0.0" }, {});
    const { stdout, code } = run(root, []);
    expect(stdout).toContain("NOT-INSTALLED");
    expect(code).toBe(1);
  });

  it("never treats a workspace link as something that could be behind", () => {
    const root = fixture({ sibling: "workspace:*" }, {});
    const { stdout, code } = run(root, []);
    expect(code).toBe(0);
    expect(stdout).not.toContain("sibling");
    expect(stdout).toContain("0 external specifiers");
  });

  // The honesty rule: an unmodelled range shape is REPORTED, never guessed at.
  it("reports an unrecognised range shape instead of guessing its bounds", () => {
    const root = fixture({ zeta: ">=1.0.0 <3" }, { zeta: "1.5.0" });
    const { stdout } = run(root, []);
    expect(stdout).toContain("UNPARSED");
    expect(stdout).toContain("zeta");
  });

  /**
   * An unreachable registry must not read as "everything is current" — and it
   * must SAY SO. `registryLatest` swallows every failure as unknown, so
   * without the UNCHECKED line a totally unreachable npm produces a clean bill
   * of health. That is not hypothetical: it is exactly how this script behaved
   * on Windows before `npm.cmd` was handled, and it is the false reassurance
   * the whole file exists to prevent.
   */
  it("says which packages it could not check rather than reporting them clean", () => {
    const root = fixture({ eta: "^0.4.0" }, { eta: "0.4.0" });
    const npm = fakeNpm({}); // answers nothing, exits 1
    const { stdout, code } = run(root, ["--registry"], npm);
    expect(stdout).not.toContain("STARVED");
    expect(stdout, "silence about an unreachable registry reads as 'all clear'").toContain(
      "UNCHECKED",
    );
    expect(stdout).toContain("eta");
    expect(stdout).not.toContain("nothing stale, nothing starved");
    expect(code, "not knowing is not a build failure — but it must be visible").toBe(0);
  });

  it("--advisory reports the same findings without failing the build", () => {
    const root = fixture({ kit: "^0.11.0" }, { kit: "0.11.0" });
    const npm = fakeNpm({ kit: "0.12.0" });
    const { stdout, code } = run(root, ["--registry", "--advisory"], npm);
    expect(stdout).toContain("STARVED");
    expect(code).toBe(0);
  });
});
