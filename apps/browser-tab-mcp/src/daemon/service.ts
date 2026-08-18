/**
 * "Keep the daemon running" — one interface, one implementation per OS.
 *
 * WHY AN ABSTRACTION RATHER THAN `if (isWindows)` INSIDE launchd.ts. The four
 * lifecycle verbs (install / uninstall / status / restart) are the same idea
 * everywhere; only the mechanism differs. Keeping the mechanisms in separate
 * modules behind one shape means `commands/daemon.ts` — the CLI surface — has
 * no platform knowledge at all, and adding a third OS is a new file rather
 * than four more branches.
 *
 * macOS  → launchd LaunchAgent (`launchd.ts`), the existing behaviour, unchanged.
 * Windows → Task Scheduler, via `schtasks`, with an `ONLOGON` trigger. That is
 *           the closest match to a per-user KeepAlive agent that needs no admin
 *           rights and no service wrapper binary: a Windows *Service* would
 *           require elevation and would run in session 0, where it could not
 *           reach the user's browser at all.
 * other  → refuses with an instruction, because a wrong guess here silently
 *          produces a daemon that never starts at boot.
 *
 * WHAT WINDOWS DOES NOT GET, AND WHY THAT IS FINE. Task Scheduler has no true
 * KeepAlive. `schtasks` can restart a task on failure, which is what the
 * install below configures; a task that exits cleanly is not restarted. The
 * daemon's own watchdog already handles the "wedged" case by exiting, and the
 * restart-on-failure count covers the crash case.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isMac, isWindows, platformId } from "../platform.js";
import {
  installLaunchAgent,
  kickstartLaunchAgent,
  launchAgentStatus,
  resolveCliPath,
  uninstallLaunchAgent,
} from "./launchd.js";

const execFileAsync = promisify(execFile);

/** The scheduled-task name. Mirrors the launchd label so logs read the same. */
export const WINDOWS_TASK_NAME = "browser-tab-daemon";

export interface ServiceManager {
  /** Human name of the mechanism, for messages and `doctor`. */
  readonly kind: string;
  install(): Promise<string>;
  uninstall(): Promise<string>;
  status(): Promise<{ loaded: boolean; detail: string }>;
  restart(restart: boolean): Promise<void>;
}

/**
 * The `schtasks /Create` argv.
 *
 * Pure and exported so the argument shape is unit-testable on any OS — the one
 * part of the Windows path that can be got wrong silently (a bad `/TR` quoting
 * produces a task that exists, reports success, and never runs).
 *
 * `/TR` takes a single command string, so the node path and script path are
 * quoted individually — Windows program paths contain spaces
 * (`C:\Program Files\nodejs\node.exe`) and an unquoted one is parsed as two
 * arguments.
 */
export function buildSchtasksCreateArgs(nodePath: string, cliPath: string): string[] {
  return [
    "/Create",
    "/TN",
    WINDOWS_TASK_NAME,
    "/TR",
    `"${nodePath}" "${cliPath}" daemon run`,
    "/SC",
    "ONLOGON",
    // Run as the logged-in user, in their session — session 0 (a real Service)
    // cannot see the user's browser.
    "/RL",
    "LIMITED",
    // Replace an existing definition instead of failing, so re-install is
    // idempotent the way `launchctl bootout && bootstrap` is.
    "/F",
  ];
}

const macService: ServiceManager = {
  kind: "launchd LaunchAgent",
  install: installLaunchAgent,
  uninstall: uninstallLaunchAgent,
  status: launchAgentStatus,
  restart: kickstartLaunchAgent,
};

/** `schtasks` unless overridden — the shim seam the screenshot path also uses. */
function schtasksBin(): string {
  return process.env.BROWSER_TAB_SCHTASKS_BIN ?? "schtasks";
}

const windowsService: ServiceManager = {
  kind: "Windows Task Scheduler (ONLOGON)",
  async install(): Promise<string> {
    const { cliPath, fromSource } = resolveCliPath();
    await execFileAsync(schtasksBin(), buildSchtasksCreateArgs(process.execPath, cliPath));
    // Creating an ONLOGON task does not start it — the user is already logged
    // in, so without this the daemon would not come up until the next logon.
    await execFileAsync(schtasksBin(), ["/Run", "/TN", WINDOWS_TASK_NAME]).catch(() => {});
    return fromSource
      ? `Scheduled task ${WINDOWS_TASK_NAME} installed (WARNING: points at the source tree ${cliPath} — run from the built bin for a stable install).`
      : `Scheduled task ${WINDOWS_TASK_NAME} installed and started.`;
  },
  async uninstall(): Promise<string> {
    try {
      await execFileAsync(schtasksBin(), ["/Delete", "/TN", WINDOWS_TASK_NAME, "/F"]);
      return `Scheduled task ${WINDOWS_TASK_NAME} removed.`;
    } catch {
      return "Scheduled task was not installed.";
    }
  },
  async status(): Promise<{ loaded: boolean; detail: string }> {
    try {
      const { stdout } = await execFileAsync(schtasksBin(), [
        "/Query",
        "/TN",
        WINDOWS_TASK_NAME,
        "/FO",
        "LIST",
      ]);
      const state = /Status:\s*(\S+)/i.exec(stdout)?.[1] ?? "?";
      return { loaded: true, detail: `registered, status=${state}` };
    } catch {
      return { loaded: false, detail: "not registered" };
    }
  },
  async restart(restart: boolean): Promise<void> {
    if (restart)
      await execFileAsync(schtasksBin(), ["/End", "/TN", WINDOWS_TASK_NAME]).catch(() => {});
    await execFileAsync(schtasksBin(), ["/Run", "/TN", WINDOWS_TASK_NAME]);
  },
};

function unsupported(verb: string): never {
  throw new Error(
    `browser-tab has no service integration for ${platformId()}, so \`daemon ${verb}\` cannot ` +
      `manage startup here. Run \`browser-tab daemon run\` under your own supervisor ` +
      `(systemd --user, supervisord, a login script) — the daemon itself is portable.`,
  );
}

const unsupportedService: ServiceManager = {
  kind: `unsupported (${platformId()})`,
  install: async () => unsupported("install"),
  uninstall: async () => unsupported("uninstall"),
  // Status is answerable everywhere: "nothing manages it" is a true answer, and
  // `daemon status` must not throw just because startup is unmanaged.
  status: async () => ({ loaded: false, detail: `no service integration for ${platformId()}` }),
  restart: async () => unsupported("restart"),
};

/** The manager for this platform. Resolved per call so tests can switch OS. */
export function serviceManager(): ServiceManager {
  if (isMac()) return macService;
  if (isWindows()) return windowsService;
  return unsupportedService;
}
