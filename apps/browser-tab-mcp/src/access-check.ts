/**
 * Doctor / preflight checks.
 *
 * Generic shape lifted from imsg-mcp/src/access-check.ts: produce a list
 * of AccessCheckItems each tool-specific repo can extend. The base set
 * checks Node version, native module availability, and config-dir
 * readability.
 */

import { accessSync, existsSync, constants as fsConstants, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { envBool } from "@george43g/robustness";
import { stateDir } from "./daemon/paths.js";
import { safariHistoryDbPath } from "./daemon/safari-history.js";
import { correlationTier } from "./detect/correlate.js";
import { enabledBrowsers, specFor } from "./detect/engine.js";
import { OsaPermissionError, osaQuote, probeProcess, runOsa } from "./detect/osascript.js";
import { APP_NAME } from "./meta.js";
import { hasNativeModule, tryLoadNative } from "./native-bridge.js";
import { hasAppleScript, hasWindowCapture, platformId, unavailableBecause } from "./platform.js";

export type CheckStatus = "ok" | "warn" | "error" | "info";

export interface AccessCheckItem {
  key: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface AccessReport {
  ok: boolean;
  items: AccessCheckItem[];
}

const REQUIRED_NODE_MAJOR = 24;

function checkNode(): AccessCheckItem {
  const match = /^v(\d+)/.exec(process.version);
  const major = match ? Number.parseInt(match[1] ?? "0", 10) : 0;
  if (major >= REQUIRED_NODE_MAJOR) {
    return {
      key: "node",
      label: `Node ${process.version}`,
      status: "ok",
      detail: `>= ${REQUIRED_NODE_MAJOR} required`,
    };
  }
  return {
    key: "node",
    label: `Node ${process.version}`,
    status: "error",
    detail: `Need Node >= ${REQUIRED_NODE_MAJOR}. Install with: nvm install ${REQUIRED_NODE_MAJOR}`,
  };
}

function checkNative(): AccessCheckItem {
  if (hasNativeModule()) {
    return {
      key: "native",
      label: "Rust accelerator",
      status: "ok",
      detail: "loaded — using accelerated path",
    };
  }
  return {
    key: "native",
    label: "Rust accelerator",
    status: "info",
    detail:
      "not loaded — using TypeScript fallback. " +
      "Run `pnpm --filter @george43g/rust-accel build` to enable, or set MCP_DISABLE_NATIVE=1 to silence.",
  };
}

function checkConfigDir(): AccessCheckItem {
  // The dir the daemon actually uses, not a re-derived guess — those diverged
  // the moment Windows moved state under %LOCALAPPDATA%, and doctor reported a
  // path nothing would ever write to.
  const dir = stateDir();
  if (!existsSync(dir)) {
    return {
      key: "configDir",
      label: `Config dir ${dir}`,
      status: "info",
      detail: "does not exist (will be created on first secrets read).",
    };
  }
  try {
    const stat = statSync(dir);
    if (!stat.isDirectory()) {
      return {
        key: "configDir",
        label: `Config dir ${dir}`,
        status: "error",
        detail: "exists but is not a directory.",
      };
    }
    return {
      key: "configDir",
      label: `Config dir ${dir}`,
      status: "ok",
      detail: "readable.",
    };
  } catch (err) {
    return {
      key: "configDir",
      label: `Config dir ${dir}`,
      status: "error",
      detail: (err as Error).message,
    };
  }
}

/**
 * Per-browser Automation (TCC Apple Events) probe. Only probes browsers
 * that are actually running — an osascript against a stopped app would
 * LAUNCH it. Denied permission (AppleScript -1743) is the classic silent
 * failure under launchd, so it's an explicit doctor error with the fix.
 */
async function checkBrowser(
  browser: ReturnType<typeof enabledBrowsers>[number],
): Promise<AccessCheckItem> {
  const spec = specFor(browser);
  const key = `browser:${browser}`;
  const { running } = await probeProcess(spec.processName);
  if (!running) {
    return {
      key,
      label: spec.appName,
      status: "info",
      detail: "not running — Automation permission probe skipped.",
    };
  }
  try {
    // No explicit timeout: first contact gets the long TCC-consent grace
    // window so the user can answer the Automation prompt mid-doctor.
    await runOsa(`tell application ${osaQuote(spec.appName)} to count windows`, {
      appName: spec.appName,
    });
    return {
      key,
      label: spec.appName,
      status: "ok",
      detail: "running; Automation permission granted.",
    };
  } catch (err) {
    if (err instanceof OsaPermissionError) {
      return { key, label: spec.appName, status: "error", detail: err.message };
    }
    return {
      key,
      label: spec.appName,
      status: "warn",
      detail: `running, but the Apple Events probe failed: ${(err as Error).message}`,
    };
  }
}

/** Which source can supply cgWindowId (the yabai join key). */
async function checkCorrelation(): Promise<AccessCheckItem> {
  const tier = await correlationTier();
  const key = "cgCorrelation";
  const label = "CG window correlation";
  if (tier === "native") {
    return { key, label, status: "ok", detail: "native CGWindowList binding loaded." };
  }
  if (tier === "yabai") {
    return { key, label, status: "ok", detail: "falling back to `yabai -m query --windows`." };
  }
  return {
    key,
    label,
    status: "warn",
    detail:
      "unavailable — cgWindowId will be null. Build the native module " +
      "(`pnpm --filter @george43g/rust-accel build`) or install yabai.",
  };
}

/**
 * Screen Recording (TCC) for tier-2 window capture. Only shown when
 * BROWSER_TAB_WINDOW_CAPTURE is on (tier 1 / captureVisibleTab needs no TCC).
 * Uses the native non-prompting preflight; without the native module we can't
 * probe, so we surface an info note instead of a false alarm.
 */
function checkScreenRecording(): AccessCheckItem {
  const key = "screenRecording";
  const label = "Screen Recording (tier-2 window capture)";
  // `screencapture -l` and the CoreGraphics preflight are both macOS. The
  // opt-in env var can be set anywhere, so say why it will not work rather
  // than probing a native module that cannot answer.
  if (!hasWindowCapture()) {
    return { key, label, status: "warn", detail: unavailableBecause("Window capture") };
  }
  const native = tryLoadNative();
  if (!native) {
    return {
      key,
      label,
      status: "info",
      detail:
        "native module not loaded — can't preflight the permission. The capture will error at " +
        "call time if it isn't granted.",
    };
  }
  if (native.preflightScreenCapture()) {
    return { key, label, status: "ok", detail: "granted." };
  }
  return {
    key,
    label,
    status: "warn",
    detail:
      "not granted — grant Screen Recording to your terminal / node binary in " +
      "System Settings → Privacy & Security → Screen Recording, then restart the daemon.",
  };
}

/**
 * Full Disk Access for Safari history (tier: reading History.db). Only shown
 * when BROWSER_TAB_SAFARI_HISTORY is on. FDA is granted per-binary, so a
 * readable check from your terminal does NOT guarantee the launchd daemon (a
 * different binary/context) can read it — we probe from here and flag the split.
 */
function checkSafariHistory(): AccessCheckItem {
  const key = "safariHistory";
  const label = "Full Disk Access (Safari history)";
  const db = safariHistoryDbPath();
  if (!existsSync(db)) {
    return {
      key,
      label,
      status: "warn",
      detail: `Safari History.db not found at ${db}. Set BROWSER_TAB_SAFARI_HISTORY_DB if it lives elsewhere.`,
    };
  }
  try {
    accessSync(db, fsConstants.R_OK);
    return {
      key,
      label,
      status: "ok",
      detail:
        "readable from this context. Note: FDA is per-binary — the launchd daemon runs a different " +
        "binary and may still be denied; if `history` errors, grant FDA to your node/daemon binary too.",
    };
  } catch {
    return {
      key,
      label,
      status: "warn",
      detail:
        "History.db isn't readable — grant Full Disk Access to the binary running browser-tab " +
        "(your terminal / node, and the launchd daemon) in System Settings → Privacy & Security → " +
        "Full Disk Access, then retry.",
    };
  }
}

/**
 * What this platform can do at all, before any probe runs.
 *
 * Without this row a Windows user sees a doctor with no browser checks and no
 * correlation check and has to infer why. Naming the mode makes "the extension
 * is the only source here" a stated fact rather than a gap.
 */
function checkPlatform(): AccessCheckItem {
  if (hasAppleScript()) {
    return {
      key: "platform",
      label: `Platform ${platformId()}`,
      status: "ok",
      detail: "AppleScript fallback + cgWindowId correlation available.",
    };
  }
  return {
    key: "platform",
    label: `Platform ${platformId()}`,
    status: "info",
    detail:
      "extension-only mode — no AppleScript fallback and no cgWindowId join " +
      "(both are macOS-only). Load the connector extension; it supplies tab and " +
      "window state and executes every write command directly.",
  };
}

export async function checkLocalAccess(): Promise<AccessReport> {
  // The AppleScript probes shell out to `osascript`, which does not exist off
  // macOS — running them would spend a subprocess each to report ENOENT.
  const browserItems =
    process.env.BROWSER_TAB_FAKE_ADAPTER === "1" || !hasAppleScript()
      ? []
      : [
          ...(await Promise.all(enabledBrowsers().map((b) => checkBrowser(b)))),
          await checkCorrelation(),
        ];
  const windowCaptureItems = envBool("BROWSER_TAB_WINDOW_CAPTURE", false)
    ? [checkScreenRecording()]
    : [];
  const safariHistoryItems = envBool("BROWSER_TAB_SAFARI_HISTORY", false)
    ? [checkSafariHistory()]
    : [];
  const items = [
    checkNode(),
    checkPlatform(),
    checkNative(),
    checkConfigDir(),
    ...browserItems,
    ...windowCaptureItems,
    ...safariHistoryItems,
  ];
  const ok = items.every((i) => i.status !== "error");
  return { ok, items };
}

export function formatAccessReport(report: AccessReport): string {
  const glyph: Record<CheckStatus, string> = {
    ok: "✓",
    warn: "⚠",
    error: "✗",
    info: "ℹ",
  };
  const lines = report.items.map((i) => `  ${glyph[i.status]}  ${i.label} — ${i.detail}`);
  lines.unshift(report.ok ? "Doctor: all clear." : "Doctor: issues found.");
  return lines.join("\n");
}
