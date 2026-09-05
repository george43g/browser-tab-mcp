#!/usr/bin/env node
/**
 * `pnpm deploy:local` — build → daemon restart → extension reload → verify,
 * as one idempotent step (plan PR-H; George's 2026-09-03 directive, ruled
 * auto-on-main-only in the adaptation record's "Post-§5 decisions").
 *
 * What it automates is the exact loop measured by hand on 2026-09-03 when
 * v1.9.0 went live, including the trap that made the verification step
 * non-negotiable: a daemon restarted from a dist built on the wrong branch
 * REPORTS healthy while running stale code, and only `daemon status`'s build
 * line (stamped `<version>+<n>.<shortsha>`) tells the truth. Step 4 asserts
 * that line against `git rev-parse --short HEAD` instead of trusting the
 * restart.
 *
 * Refusals and skips, in order:
 *  - CI set                      → skip, exit 0 (runners have no daemon)
 *  - branch is not `main`        → REFUSE, exit 1 (`--allow-branch` overrides,
 *                                  loudly — a feature-branch build replacing
 *                                  the live daemon is the hazard this shape
 *                                  exists to prevent)
 *  - no daemon service installed → skip, exit 0 (nothing to deploy to)
 *  - build/restart/verify fails  → exit non-zero with the observed state
 *
 * The post-merge hook (.githooks/post-merge) wraps this advisorily: it only
 * fires on main, only when the merge touched build inputs, and always exits 0
 * so a failed deploy can never break `git pull`.
 *
 * Node wrapper, not shell: `VAR=$(...)` and `2>/dev/null` are syntax errors
 * under cmd.exe (repo platform rule).
 *
 * Test shims (documented in apps/browser-tab-mcp/.env.example):
 *  - BROWSER_TAB_DEPLOY_CLI      path to the browser-tab cli entry (default:
 *                                the repo's own dist/cli.js)
 *  - BROWSER_TAB_DEPLOY_POLL_MS  verification poll interval (default 1000)
 *  - BROWSER_TAB_DEPLOY_TRIES    verification poll attempts (default 60)
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliPath =
  process.env.BROWSER_TAB_DEPLOY_CLI ?? join(repoRoot, "apps/browser-tab-mcp/dist/cli.js");
/**
 * 60s, and the number is measured rather than chosen.
 *
 * The old budget was 10s (20 x 500ms) and produced a FALSE "daemon did not
 * come up" on two consecutive real merges — which is worse than useless,
 * because the script exits there and never reaches the checks that follow it.
 * Measured on this Mac 2026-09-05: `daemon restart` RETURNS in 226ms and the
 * daemon becomes reachable 20,514ms later. The gap is structural, not load:
 * the outgoing process hits its own 3s shutdown force-exit net (the
 * `cleanup_timeout` lines in daemon.err.log), and launchd will not respawn a
 * job faster than its ThrottleInterval, which defaults to 10s. 3 + 10 + node
 * boot is the ~20s observed, so any budget under that fails by construction
 * on a healthy machine.
 */
const pollMs = Number(process.env.BROWSER_TAB_DEPLOY_POLL_MS ?? 1000);
const tries = Number(process.env.BROWSER_TAB_DEPLOY_TRIES ?? 60);
const allowBranch = process.argv.includes("--allow-branch");

const say = (line) => process.stdout.write(`deploy:local ${line}\n`);

function git(...args) {
  // One command string: spawnSync(cmd, argsArray, {shell:true}) trips Node's
  // DEP0190 (args are concatenated unescaped under a shell). These are fixed
  // words, never user input.
  const run = spawnSync(["git", ...args].join(" "), {
    cwd: repoRoot,
    encoding: "utf8",
    shell: true,
  });
  return run.status === 0 ? run.stdout.trim() : undefined;
}

function cli(...args) {
  const run = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

function daemonStatus() {
  const run = cli("daemon", "status", "--json");
  try {
    return JSON.parse(run.stdout);
  } catch {
    return undefined;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. Environment and branch gates.
if (process.env.CI) {
  say("skipped: CI environment has no daemon to deploy to.");
  process.exit(0);
}
const branch = git("branch", "--show-current");
if (branch !== "main" && !allowBranch) {
  say(
    `REFUSED: on branch "${branch ?? "(detached)"}", not main. A feature-branch build ` +
      "replacing the live daemon is the rebuild-on-wrong-branch trap. " +
      "Pass --allow-branch only when that is genuinely what you want.",
  );
  process.exit(1);
}
if (branch !== "main") say(`WARNING: deploying from branch "${branch}" (--allow-branch).`);

// 2. Anything to deploy to? Probe BEFORE spending a build.
if (!existsSync(cliPath)) {
  say(`skipped: no built cli at ${cliPath} — nothing is deployed on this machine yet.`);
  process.exit(0);
}
const before = daemonStatus();
if (before === undefined) {
  say("skipped: `daemon status` produced no parseable state — no usable daemon here.");
  process.exit(0);
}
if (/not loaded|not registered|no service integration/.test(String(before.launchAgent ?? ""))) {
  say(`skipped: daemon service is not installed (${before.launchAgent}).`);
  process.exit(0);
}

// 3. Build (the pnpm script, never bare turbo — BUILD_STAMP is part of the
// cache key and the build line depends on it).
say(`building on ${branch}…`);
const build = spawnSync("pnpm", ["build"], { cwd: repoRoot, stdio: "inherit", shell: true });
if (build.status !== 0) {
  say(`FAILED: pnpm build exited ${build.status}.`);
  process.exit(build.status ?? 1);
}

// 4. Restart, then verify the daemon actually runs THIS commit's build.
const restart = cli("daemon", "restart");
if (restart.status !== 0) {
  say(`FAILED: daemon restart exited ${restart.status}: ${restart.stderr || restart.stdout}`);
  process.exit(1);
}
const sha = git("rev-parse", "--short", "HEAD");
// A dirty working tree stamps `<v>+<n>.<sha>.dirty.<ts>` (measured on the
// first post-merge firing with an agent's WIP files present — the daemon was
// on the right commit and the verifier called it a failure). Accept the
// dirty form, but say so: the deploy is the declared commit plus whatever
// uncommitted state the tree held at build time.
const onBuild = (b) =>
  typeof b === "string" && (b.endsWith(`.${sha}`) || b.includes(`.${sha}.dirty.`));
let live;
for (let i = 0; i < tries; i++) {
  live = daemonStatus();
  if (live?.reachable === true && onBuild(live.build)) break;
  live = undefined;
  await sleep(pollMs);
}
if (live === undefined) {
  const seen = daemonStatus();
  say(
    `FAILED: daemon did not come up on build .${sha} within ${tries * pollMs}ms — ` +
      `observed build "${seen?.build ?? "(unreachable)"}". The running daemon and this ` +
      "checkout now disagree; investigate before trusting live verification.",
  );
  process.exit(1);
}

// 5. Reload every extension from disk — but only AFTER it has reconnected to
// the restarted daemon. Measured on the first live firing (2026-09-03): the
// restart drops every extension session, they re-handshake over a few
// seconds, and a reload issued before that lands on "session not connected" —
// the browser then reconnects still running the PREVIOUS bundle while a
// connection-only check calls the deploy ok. So: wait for reconnect, reload,
// re-assert, and name any browser left un-reloaded in the verdict.
const expected = Array.isArray(before.extensions) ? before.extensions : [];
const unreloaded = [];
if (expected.length > 0) {
  let connected = [];
  for (let i = 0; i < tries; i++) {
    connected = daemonStatus()?.extensions ?? [];
    if (expected.every((b) => connected.includes(b))) break;
    await sleep(pollMs);
  }
  const missing = expected.filter((b) => !connected.includes(b));
  if (missing.length > 0) {
    say(
      `FAILED: extension(s) did not reconnect after the daemon restart: ${missing.join(", ")} ` +
        `(connected: ${connected.join(", ") || "none"}).`,
    );
    process.exit(1);
  }
  for (const browser of expected) {
    const reload = cli("reload-extension", "--browser", String(browser), "--json");
    if (reload.status !== 0) {
      unreloaded.push(browser);
      say(`warning: reload-extension ${browser} failed: ${reload.stderr || reload.stdout}`);
    }
  }
  for (let i = 0; i < tries; i++) {
    connected = daemonStatus()?.extensions ?? [];
    if (expected.every((b) => connected.includes(b))) break;
    await sleep(pollMs);
  }
  const gone = expected.filter((b) => !connected.includes(b));
  if (gone.length > 0) {
    say(
      `FAILED: extension(s) did not reconnect after reload: ${gone.join(", ")} ` +
        `(connected: ${connected.join(", ") || "none"}).`,
    );
    process.exit(1);
  }

  // A RECONNECTION IS NOT A RELOAD. The check above proves the extension came
  // back; it says nothing about which bundle came back with it, and that is
  // the whole question this script exists to answer. Measured 2026-09-05:
  // Safari had been reporting `extVersion: "1.3.1+71.7b72707"` for months —
  // a bundle from long before the version was 1.11.0 — while every deploy
  // printed "extensions [chrome, safari] reloaded and reconnected", and
  // Chrome sat one commit behind after a reload that never ran. Both were
  // invisible because nothing compared the versions, and the daemon has been
  // reporting `extensionInfo[].extVersion` the entire time.
  //
  // The remedy differs by browser and the message says so: a Chromium-family
  // extension reloads from disk, while Safari's is packaged into an app
  // bundle and needs a `sideload` (xcodebuild) before a reload can pick
  // anything up. This FAILS rather than warns — a loop that knowingly reports
  // ok while a browser runs months-old code is the pathway-that-passes-
  // because-nothing-looked that this repo keeps paying for. The post-merge
  // hook is advisory, so a loud failure blocks nothing; it just stops the
  // silence.
  const info = Array.isArray(live?.extensionInfo) ? live.extensionInfo : [];
  const fresh = daemonStatus();
  const infoNow = Array.isArray(fresh?.extensionInfo) ? fresh.extensionInfo : info;
  const staleBundles = infoNow.filter(
    (e) => e && typeof e.extVersion === "string" && !onBuild(e.extVersion),
  );
  if (staleBundles.length > 0) {
    const detail = staleBundles
      .map((e) => {
        const remedy =
          e.browser === "safari"
            ? "needs `pnpm --filter @george43g/safari-extension sideload` (Safari loads from an app bundle, not dist)"
            : "retry `browser-tab reload-extension --browser " + String(e.browser) + "`";
        return `${e.browser} is on "${e.extVersion}" — ${remedy}`;
      })
      .join("; ");
    say(
      `FAILED: extension(s) reconnected but are NOT running this build (.${sha}): ${detail}. ` +
        "A reconnection is not a reload.",
    );
    process.exit(1);
  }
}

if (String(live.build ?? "").includes(".dirty.")) {
  say(
    `warning: deployed from a DIRTY tree (build ${live.build}) — the daemon runs this ` +
      "commit plus uncommitted local state.",
  );
}
const extNote =
  unreloaded.length > 0
    ? `extensions reloaded except [${unreloaded.join(", ")}] — reconnected but running the previous bundle; retry with \`browser-tab reload-extension\``
    : `extensions [${expected.join(", ") || "none"}] reloaded and reconnected`;
say(`ok — daemon ${live.build}, ${extNote}.`);
