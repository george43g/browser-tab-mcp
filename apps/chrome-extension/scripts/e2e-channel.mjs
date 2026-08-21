#!/usr/bin/env node
/**
 * Cross-shell wrapper behind `test:e2e:chrome` / `test:e2e:edge`.
 *
 * A bare `"test:e2e:edge": "playwright test"` script can't carry an env var
 * into the process on cmd.exe — `E2E_BROWSER_CHANNEL=chrome playwright test`
 * is a POSIX-shell idiom only, and these are local convenience scripts meant
 * to work the same in zsh and PowerShell. `cross-env` isn't already a repo
 * dependency, so rather than adding one for two scripts, this sets the var in
 * Node — the one runtime already required on every platform this repo
 * targets — then execs Playwright with it. CI does NOT use this: the
 * `e2e-branded` job sets `E2E_BROWSER_CHANNEL` at the workflow-step level and
 * calls `test:e2e` directly.
 *
 * Usage: node scripts/e2e-channel.mjs <chrome|msedge>
 */
import { spawnSync } from "node:child_process";

const channel = process.argv[2];
if (channel !== "chrome" && channel !== "msedge") {
  console.error(`usage: node scripts/e2e-channel.mjs <chrome|msedge>, got "${channel}"`);
  process.exit(1);
}

const result = spawnSync("playwright", ["test"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, E2E_BROWSER_CHANNEL: channel },
});

process.exit(result.status ?? 1);
