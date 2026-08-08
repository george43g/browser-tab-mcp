/**
 * Bounded osascript execution.
 *
 * Every AppleScript call is hard-bounded: browsers can wedge osascript
 * indefinitely (busy renderer, TCC permission prompt). We use execFile's
 * own timeout so the child is SIGKILLed — withTimeout alone would unblock
 * us but leave a zombie osascript pinning the browser's Apple Events queue.
 *
 * TCC: the calling process needs Automation permission for each target
 * browser (System Settings > Privacy & Security > Automation). Denied
 * permission surfaces as AppleScript error -1743, mapped here to
 * OsaPermissionError with an actionable hint.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { envNum, withRetry } from "@george43g/robustness";

const execFileAsync = promisify(execFile);

export class OsaPermissionError extends Error {
  constructor(appName: string) {
    super(
      `Not authorized to send Apple events to "${appName}". ` +
        `Grant Automation permission in System Settings > Privacy & Security > Automation ` +
        `(or reset with: tccutil reset AppleEvents).`,
    );
    this.name = "OsaPermissionError";
  }
}

export class OsaTimeoutError extends Error {
  constructor(appName: string, timeoutMs: number) {
    super(
      `osascript against "${appName}" timed out after ${timeoutMs}ms. ` +
        `The browser may be showing a modal dialog or a busy renderer is blocking Apple Events.`,
    );
    this.name = "OsaTimeoutError";
  }
}

export function osaTimeoutMs(): number {
  return envNum("BROWSER_TAB_OSA_TIMEOUT_MS", 5_000);
}

/**
 * TCC first-contact grace: the very first Apple Events call to an app from
 * a new launch context (e.g. node under launchd) pops the macOS Automation
 * consent dialog, and osascript BLOCKS until the user answers. Killing it
 * at the normal 5s timeout dismisses the dialog — and the next poll
 * re-prompts, an unanswerable loop. Until an app has answered successfully
 * once in this process, allow a long window for the human to click.
 */
const FIRST_CONTACT_TIMEOUT_MS = 60_000;
const succeededApps = new Set<string>();

export function effectiveOsaTimeoutMs(appName: string): number {
  const base = osaTimeoutMs();
  return succeededApps.has(appName) ? base : Math.max(base, FIRST_CONTACT_TIMEOUT_MS);
}

/**
 * Run an AppleScript source, returning stdout. Throws OsaPermissionError /
 * OsaTimeoutError / Error with the osascript stderr as message.
 */
export async function runOsa(
  script: string,
  opts: { appName: string; timeoutMs?: number; signal?: AbortSignal } = { appName: "unknown" },
): Promise<string> {
  const timeoutMs = opts.timeoutMs ?? effectiveOsaTimeoutMs(opts.appName);
  try {
    const { stdout } = await execFileAsync("/usr/bin/osascript", ["-e", script], {
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: 32 * 1024 * 1024,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    succeededApps.add(opts.appName);
    return stdout;
  } catch (err) {
    const e = err as NodeJS.ErrnoException & {
      stderr?: string;
      killed?: boolean;
      signal?: string;
    };
    const stderr = e.stderr ?? "";
    if (stderr.includes("-1743") || stderr.includes("Not authorized to send Apple events")) {
      throw new OsaPermissionError(opts.appName);
    }
    if (e.killed || e.code === "ETIMEDOUT" || e.signal === "SIGKILL") {
      throw new OsaTimeoutError(opts.appName, timeoutMs);
    }
    throw new Error(`osascript failed for "${opts.appName}": ${stderr.trim() || e.message}`);
  }
}

/**
 * Retry-wrapped `runOsa` for READ-ONLY scripts.
 *
 * This exists as a separate export rather than a `retry` flag because the
 * read/write distinction is the entire safety argument: `runOsa` also carries
 * focus/close/move, and replaying one of those after a partial failure would
 * close or move a second tab. Only reads are idempotent, so only reads may be
 * retried — never call this with a script that mutates.
 *
 * Retries the generic "osascript failed" case only, which is what a browser
 * mid-launch or mid-quit produces (AppleEvent -600 / -10000) and which today
 * surfaces as a hard error on an otherwise fine snapshot. Deliberately NOT
 * retried:
 *   - OsaPermissionError — permanent until the user grants TCC; retrying only
 *     delays an actionable message.
 *   - OsaTimeoutError — it already burned the full timeout (and the first-
 *     contact case can be 60s); stacking those would wedge the poll loop.
 * Delays stay short for the same reason: the engine loop is itself a retry
 * cadence, so this is only here to paper over a sub-second blip.
 */
export function shouldRetryOsaRead(err: unknown): boolean {
  return !(err instanceof OsaPermissionError || err instanceof OsaTimeoutError);
}

export function runOsaRead(
  script: string,
  opts: { appName: string; timeoutMs?: number; signal?: AbortSignal } = { appName: "unknown" },
): Promise<string> {
  return withRetry(() => runOsa(script, opts), {
    label: `osa_read:${opts.appName}`,
    maxAttempts: 2,
    baseMs: 150,
    capMs: 500,
    shouldRetry: shouldRetryOsaRead,
  });
}

/** Escape a string for embedding inside an AppleScript double-quoted literal. */
export function osaQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * pgrep-based process probe. Exact-name match so browser helper processes
 * ("Google Chrome Helper") don't count. Returns the first (main) pid.
 * Never launches the browser — this is the guard that keeps AppleScript
 * from auto-starting an app that isn't running.
 */
export async function probeProcess(
  processName: string,
  signal?: AbortSignal,
): Promise<{ running: boolean; pid: number | null }> {
  try {
    const { stdout } = await execFileAsync("/usr/bin/pgrep", ["-x", processName], {
      timeout: 2_000,
      ...(signal ? { signal } : {}),
    });
    const first = stdout.trim().split("\n")[0] ?? "";
    const pid = Number.parseInt(first, 10);
    return { running: true, pid: Number.isFinite(pid) ? pid : null };
  } catch {
    return { running: false, pid: null };
  }
}
