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

const installedStatus = (build: string, extensions: string[] = []) => ({
  launchAgent: "launchd LaunchAgent: loaded, state=running, pid=1",
  reachable: true,
  build,
  extensions,
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

  it("FAILS when the restarted daemon never reports this commit's build line", () => {
    const stale = installedStatus("1.0.0+1.0ldsha0");
    const w = makeWorld({ statuses: [stale, stale] });
    const run = runDeploy(w);
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/did not come up on build \.abc1234/);
    expect(run.stdout).toMatch(/observed build "1\.0\.0\+1\.0ldsha0"/);
  });
});
