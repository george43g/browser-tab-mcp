/**
 * launchd LaunchAgent management: install / uninstall / status.
 *
 * The plist runs `node <cli.js> daemon run` with KeepAlive, so the daemon
 * survives crashes and logins. TCC note: Automation permission attributes
 * to the node binary in this launch context — a node upgrade (new binary
 * path/signature) can silently re-prompt; `browser-tab doctor` surfaces
 * the resulting -1743 errors.
 */

import { execFile } from "node:child_process";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { LAUNCHD_LABEL, launchAgentPlistPath, logDir } from "./paths.js";

const execFileAsync = promisify(execFile);

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function buildPlist(nodePath: string, cliPath: string): string {
  const args = [nodePath, cliPath, "daemon", "run"]
    .map((a) => `    <string>${xmlEscape(a)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <!--
    Minimum seconds between respawns. launchd's default is 10, which is a fine
    figure for a daemon that crashes once; it is the wrong one for a daemon in
    a restart loop, where it means ~360 cold starts an hour, each of them CPU
    -intensive module loading. That is not hypothetical here: the watchdog
    self-kills on sustained event-loop lag, and on a saturated host that lag is
    imposed from OUTSIDE the process, so the restart adds load to the machine
    that caused it (BACKLOG B15; the real fix is upstream in robustness).
    30s keeps recovery prompt while capping the loop's cost.
  -->
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(`${logDir()}/daemon.out.log`)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(`${logDir()}/daemon.err.log`)}</string>
</dict>
</plist>
`;
}

function gui(): string {
  return `gui/${process.getuid?.() ?? 501}`;
}

/** The entry the plist should point at. Warns when running from source. */
export function resolveCliPath(): { cliPath: string; fromSource: boolean } {
  const argv1 = resolve(process.argv[1] ?? "");
  return { cliPath: argv1, fromSource: !argv1.endsWith("/dist/cli.js") };
}

export async function installLaunchAgent(): Promise<string> {
  const { cliPath, fromSource } = resolveCliPath();
  const plist = buildPlist(process.execPath, cliPath);
  const path = launchAgentPlistPath();
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(logDir(), { recursive: true });
  writeFileSync(path, plist);
  // bootout first so re-install picks up plist changes; ignore "not loaded".
  await execFileAsync("launchctl", ["bootout", gui(), path]).catch(() => {});
  await execFileAsync("launchctl", ["bootstrap", gui(), path]);
  return fromSource
    ? `${path} installed (WARNING: points at the source tree ${cliPath} — run from the built bin for a stable install).`
    : `${path} installed and bootstrapped.`;
}

export async function uninstallLaunchAgent(): Promise<string> {
  const path = launchAgentPlistPath();
  await execFileAsync("launchctl", ["bootout", gui(), path]).catch(() => {});
  try {
    unlinkSync(path);
    return `${path} removed.`;
  } catch {
    return `LaunchAgent was not installed.`;
  }
}

export async function launchAgentStatus(): Promise<{ loaded: boolean; detail: string }> {
  try {
    const { stdout } = await execFileAsync("launchctl", ["print", `${gui()}/${LAUNCHD_LABEL}`]);
    const pidMatch = /pid = (\d+)/.exec(stdout);
    const stateMatch = /state = (\w+)/.exec(stdout);
    return {
      loaded: true,
      detail: `loaded, state=${stateMatch?.[1] ?? "?"}${pidMatch ? `, pid=${pidMatch[1]}` : ""}`,
    };
  } catch {
    return { loaded: false, detail: "not loaded" };
  }
}

export async function kickstartLaunchAgent(restart: boolean): Promise<void> {
  await execFileAsync("launchctl", [
    "kickstart",
    ...(restart ? ["-k"] : []),
    `${gui()}/${LAUNCHD_LABEL}`,
  ]);
}
