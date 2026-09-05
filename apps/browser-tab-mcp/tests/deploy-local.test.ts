/**
 * The deploy loop (scripts/deploy-local.mjs, wired as `pnpm deploy:local` and
 * fired advisorily by .githooks/post-merge) must: refuse off-main, skip
 * cleanly where there is nothing to deploy to, and — the reason it exists —
 * FAIL when the restarted daemon's build line does not carry the current
 * commit (the rebuild-on-wrong-branch trap, where a healthy-looking daemon
 * runs stale code). CI cannot exercise the real loop (no daemon on runners;
 * the script itself skips under CI), so these tests manufacture every world
 * via PATH fakes (`git`, `pnpm`) and a scripted fake cli
 * (BROWSER_TAB_DEPLOY_CLI), per the build-rust-optional pattern.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT = resolve(__dirname, "../../../scripts/deploy-local.mjs");
const isWin = process.platform === "win32";

/** A PATH-resolvable fake that defers to a Node implementation script. */
function makeNodeFake(dir: string, name: string, implPath: string): void {
  if (isWin) {
    writeFileSync(join(dir, `${name}.cmd`), `@"${process.execPath}" "${implPath}" %*\r\n`);
  } else {
    const p = join(dir, name);
    writeFileSync(p, `#!/bin/sh\nexec "${process.execPath}" "${implPath}" "$@"\n`);
    chmodSync(p, 0o755);
  }
}

interface World {
  branch?: string;
  /** Sequence of `daemon status` payloads; the last one repeats. */
  statuses: unknown[];
  restartExit?: number;
  reloadExit?: number;
}

function makeWorld(world: World) {
  const dir = mkdtempSync(join(tmpdir(), "bt-deploy-"));
  const stateFile = join(dir, "state.json");
  writeFileSync(stateFile, JSON.stringify({ statusCalls: 0, reloads: [] }));

  writeFileSync(
    join(dir, "git-impl.mjs"),
    `const a = process.argv.slice(2).join(" ");
if (a.includes("branch --show-current")) process.stdout.write(${JSON.stringify(world.branch ?? "main")});
else if (a.includes("rev-parse --short")) process.stdout.write("abc1234");
else process.stdout.write("");
`,
  );
  makeNodeFake(dir, "git", join(dir, "git-impl.mjs"));

  writeFileSync(
    join(dir, "pnpm-impl.mjs"),
    `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(dir, "pnpm-ran"))}, process.argv.slice(2).join(" "));
`,
  );
  makeNodeFake(dir, "pnpm", join(dir, "pnpm-impl.mjs"));

  const fakeCli = join(dir, "fake-cli.mjs");
  writeFileSync(
    fakeCli,
    `import { readFileSync, writeFileSync } from "node:fs";
const stateFile = ${JSON.stringify(stateFile)};
const statuses = ${JSON.stringify(world.statuses)};
const state = JSON.parse(readFileSync(stateFile, "utf8"));
const args = process.argv.slice(2).join(" ");
if (args.startsWith("daemon status")) {
  const payload = statuses[Math.min(state.statusCalls, statuses.length - 1)];
  state.statusCalls += 1;
  writeFileSync(stateFile, JSON.stringify(state));
  if (payload === null) process.exit(1);
  process.stdout.write(JSON.stringify(payload));
  process.exit(0);
}
if (args.startsWith("daemon restart")) process.exit(${world.restartExit ?? 0});
if (args.startsWith("reload-extension")) {
  state.reloads.push(args + " @" + state.statusCalls);
  writeFileSync(stateFile, JSON.stringify(state));
  process.exit(${world.reloadExit ?? 0});
}
process.exit(2);
`,
  );

  return { dir, stateFile, fakeCli };
}

function runDeploy(
  w: ReturnType<typeof makeWorld>,
  extraEnv: Record<string, string | undefined> = {},
  args: string[] = [],
) {
  const pathValue = w.dir;
  const run = spawnSync(process.execPath, [SCRIPT, ...args], {
    env: {
      ...process.env,
      CI: undefined,
      PATH: pathValue,
      ...(isWin ? { Path: pathValue, PATHEXT: ".COM;.EXE;.BAT;.CMD" } : {}),
      BROWSER_TAB_DEPLOY_CLI: w.fakeCli,
      BROWSER_TAB_DEPLOY_POLL_MS: "10",
      BROWSER_TAB_DEPLOY_TRIES: "3",
      ...extraEnv,
    },
    encoding: "utf8",
    timeout: 30_000,
  });
  return run;
}

const installedStatus = (
  build: string,
  extensions: string[] = [],
  /**
   * Per-extension bundle identity. Omitted = the daemon reported none, which
   * the loop treats leniently (an older daemon predates the field); the tests
   * that exercise the bundle check pass it explicitly. Default here mirrors a
   * healthy fleet: every extension on the daemon's own build.
   */
  extensionInfo?: Array<{ browser: string; extVersion: string }>,
) => ({
  launchAgent: "launchd LaunchAgent: loaded, state=running, pid=1",
  reachable: true,
  build,
  extensions,
  extensionInfo: extensionInfo ?? extensions.map((browser) => ({ browser, extVersion: build })),
});

describe("deploy-local", () => {
  it("refuses off-main without --allow-branch, before building anything", () => {
    const w = makeWorld({ branch: "feat/x", statuses: [installedStatus("1.0.0+1.abc1234")] });
    const run = runDeploy(w);
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/REFUSED/);
    expect(run.stdout).toMatch(/rebuild-on-wrong-branch/);
    expect(existsSync(join(w.dir, "pnpm-ran"))).toBe(false);
  });

  it("skips with exit 0 under CI", () => {
    const w = makeWorld({ statuses: [installedStatus("1.0.0+1.abc1234")] });
    const run = runDeploy(w, { CI: "1" });
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/skipped: CI/);
  });

  it("skips with exit 0 when the daemon service is not installed, without building", () => {
    const w = makeWorld({
      statuses: [{ launchAgent: "launchd LaunchAgent: not loaded", reachable: false }],
    });
    const run = runDeploy(w);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/skipped: daemon service is not installed/);
    expect(existsSync(join(w.dir, "pnpm-ran"))).toBe(false);
  });

  it("deploys: builds, restarts, verifies the build line, reloads each extension", () => {
    const w = makeWorld({
      statuses: [
        installedStatus("1.0.0+1.0ldsha0", ["chrome", "safari"]),
        installedStatus("1.0.0+2.abc1234", ["chrome", "safari"]),
      ],
    });
    const run = runDeploy(w);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/ok — daemon 1\.0\.0\+2\.abc1234/);
    expect(run.stdout).toMatch(/reloaded and reconnected/);
    expect(readFileSync(join(w.dir, "pnpm-ran"), "utf8")).toBe("build");
    const state = JSON.parse(readFileSync(w.stateFile, "utf8"));
    expect(state.reloads).toEqual([
      expect.stringContaining("--browser chrome"),
      expect.stringContaining("--browser safari"),
    ]);
    // Reload-after-reconnect ordering (the first live firing's finding): every
    // reload must land after the post-restart reconnect wait has read status —
    // ≥3 reads (presence probe, build-line verify, reconnect wait) before any.
    for (const entry of state.reloads) {
      expect(Number(entry.split("@")[1])).toBeGreaterThanOrEqual(3);
    }
  });

  it("names a browser whose reload failed in the verdict, without failing the deploy", () => {
    const w = makeWorld({
      statuses: [
        installedStatus("1.0.0+1.0ldsha0", ["chrome"]),
        installedStatus("1.0.0+2.abc1234", ["chrome"]),
      ],
      reloadExit: 1,
    });
    const run = runDeploy(w);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/warning: reload-extension chrome failed/);
    expect(run.stdout).toMatch(/reloaded except \[chrome\]/);
    expect(run.stdout).toMatch(/running the previous bundle/);
  });

  it("waits long enough for a real launchd restart — the budget is measured, not chosen", () => {
    // Measured on a healthy Mac 2026-09-05: `daemon restart` returns in 226ms
    // and the daemon is reachable 20,514ms later — the outgoing process hits
    // its 3s shutdown force-exit net and launchd will not respawn faster than
    // its 10s ThrottleInterval. The previous 10s budget produced a FALSE
    // "daemon did not come up" on two consecutive real merges, and the script
    // exits there, so every check after it silently never ran.
    const src = readFileSync(SCRIPT, "utf8");
    const pollMs = Number(/DEPLOY_POLL_MS \?\? (\d+)/.exec(src)?.[1]);
    const tries = Number(/DEPLOY_TRIES \?\? (\d+)/.exec(src)?.[1]);
    expect(Number.isFinite(pollMs) && Number.isFinite(tries), "budget is readable").toBe(true);
    expect(
      pollMs * tries,
      "default wait budget must clear the measured ~20s",
    ).toBeGreaterThanOrEqual(45_000);
  });

  it("FAILS when an extension reconnects still running the previous bundle", () => {
    // The defect this closes, measured 2026-09-05 on the real fleet: Safari
    // had been reporting extVersion "1.3.1+71.7b72707" for months while every
    // deploy printed "reloaded and reconnected", because nothing compared the
    // versions. A reconnection is not a reload.
    const w = makeWorld({
      statuses: [
        installedStatus("1.0.0+1.0ldsha0", ["chrome"]),
        installedStatus(
          "1.0.0+2.abc1234",
          ["chrome"],
          [{ browser: "chrome", extVersion: "1.0.0+1.0ldsha0" }],
        ),
      ],
    });
    const run = runDeploy(w);
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/NOT running this build/);
    expect(run.stdout, "names the browser AND what it is actually on").toMatch(
      /chrome is on "1\.0\.0\+1\.0ldsha0"/,
    );
    expect(run.stdout).toMatch(/reload-extension --browser chrome/);
  });

  it("gives Safari its OWN remedy — a reload cannot fix an app-bundled extension", () => {
    const w = makeWorld({
      statuses: [
        installedStatus("1.0.0+1.0ldsha0", ["safari"]),
        installedStatus(
          "1.0.0+2.abc1234",
          ["safari"],
          [{ browser: "safari", extVersion: "1.3.1+71.7b72707" }],
        ),
      ],
    });
    const run = runDeploy(w);
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/safari-extension sideload/);
    expect(run.stdout, "pointing Safari at reload-extension would be wrong advice").not.toMatch(
      /retry `browser-tab reload-extension --browser safari`/,
    );
  });

  it("accepts a dirty-tree stamp for the right commit, warning about the dirt", () => {
    const w = makeWorld({
      statuses: [
        installedStatus("1.0.0+1.0ldsha0", ["chrome"]),
        installedStatus("1.0.0+2.abc1234.dirty.0903T0307", ["chrome"]),
      ],
    });
    const run = runDeploy(w);
    expect(run.status).toBe(0);
    expect(run.stdout).toMatch(/DIRTY tree/);
    expect(run.stdout).toMatch(/ok — daemon 1\.0\.0\+2\.abc1234\.dirty/);
  });

  it("does NOT accept a dirty stamp for a DIFFERENT commit", () => {
    const stale = installedStatus("1.0.0+1.0ldsha0.dirty.0903T0307");
    const w = makeWorld({ statuses: [stale, stale] });
    const run = runDeploy(w);
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/did not come up on build \.abc1234/);
  });

  it("FAILS when the restarted daemon never reports this commit's build line", () => {
    const stale = installedStatus("1.0.0+1.0ldsha0");
    const w = makeWorld({ statuses: [stale, stale] });
    const run = runDeploy(w);
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/did not come up on build \.abc1234/);
    expect(run.stdout).toMatch(/observed build "1\.0\.0\+1\.0ldsha0"/);
  });
});
