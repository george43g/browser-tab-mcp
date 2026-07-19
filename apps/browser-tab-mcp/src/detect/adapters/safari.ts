/**
 * Safari adapter.
 *
 * Reads work like Chromium's, with one structural difference: Safari's
 * AppleScript dictionary has NO stable tab id — tab identity is
 * (window id, 1-based index), encoded as a synthetic tabId that is
 * reissued whenever tabs reorder. Windows without tabs (downloads,
 * preferences) throw inside the script and are skipped by the try block.
 *
 * moveTab exists in Safari AppleScript (`move tab i of w to end of tabs
 * of w2`) but RELOADS the page — keeps URL/position, loses scroll, form
 * and JS state. It's gated behind input.allowReload until the Safari
 * extension pathway (M6) provides a true move.
 */

import { sanitize } from "@george43g/mcp-kit";
import type {
  BrowserState,
  BrowserWindow,
  CommandResult,
  MoveTabInput,
  OpenTabInput,
} from "@george43g/shared-types";
import { makeSafariTabId, makeWindowId, parseTabId, parseWindowId } from "../ids.js";
import { osaQuote, probeProcess, runOsa } from "../osascript.js";
import { parseRecordOutput } from "../parse.js";
import type { AdapterSpec, BrowserAdapter } from "./types.js";

export const SAFARI_SPEC: AdapterSpec = {
  browser: "safari",
  appName: "Safari",
  bundleId: "com.apple.Safari",
  processName: "Safari",
};

const RS_EXPR = `(character id 30)`;

const READ_SCRIPT = `
tell application "Safari"
  set rs to ${RS_EXPR}
  set out to "A" & rs & (frontmost as text) & linefeed
  repeat with w in windows
    try
      set b to bounds of w
      set activeIdx to 0
      try
        set activeIdx to index of current tab of w
      end try
      set out to out & "W" & rs & (id of w as text) & rs & (item 1 of b) & rs & (item 2 of b) & rs & (item 3 of b) & rs & (item 4 of b) & rs & activeIdx & rs & "normal" & rs & (name of w) & linefeed
      repeat with t in tabs of w
        set tUrl to ""
        set tName to ""
        try
          set u to URL of t
          if u is not missing value then set tUrl to u
        end try
        try
          set n to name of t
          if n is not missing value then set tName to n
        end try
        set out to out & "T" & rs & (index of t as text) & rs & tUrl & rs & tName & linefeed
      end repeat
    end try
  end repeat
  return out
end tell`;

interface SafariRef {
  nativeWindowId: string;
  index1: number;
}

function requireSafariTab(tabId: string): SafariRef {
  const parsed = parseTabId(tabId);
  if (!parsed || parsed.browser !== "safari" || !parsed.safari) {
    throw new Error(`tabId "${tabId}" is not a safari tab handle from list_tabs.`);
  }
  if (!/^\d+$/.test(parsed.safari.nativeWindowId) || !Number.isInteger(parsed.safari.index1)) {
    throw new Error(`Malformed safari tabId.`);
  }
  return parsed.safari;
}

/** AppleScript prologue that binds `w` to the window with the given id, or returns "not_found". */
function findWindowClause(nativeWindowId: string): string {
  return `
  set target to missing value
  repeat with w in windows
    if (id of w as text) is "${nativeWindowId}" then
      set target to w
    end if
  end repeat
  if target is missing value then return "not_found"`;
}

export function makeSafariAdapter(): BrowserAdapter {
  const spec = SAFARI_SPEC;

  const emptyState = (pid: number | null, running: boolean, error?: string): BrowserState => ({
    browser: spec.browser,
    bundleId: spec.bundleId,
    pid,
    running,
    extensionConnected: false,
    dataSource: "applescript",
    ...(error !== undefined ? { error } : {}),
    windows: [],
  });

  async function readState(signal?: AbortSignal): Promise<BrowserState> {
    const { running, pid } = await probeProcess(spec.processName, signal);
    if (!running) return emptyState(null, false);

    let raw: string;
    try {
      raw = await runOsa(READ_SCRIPT, { appName: spec.appName, ...(signal ? { signal } : {}) });
    } catch (err) {
      return emptyState(pid, true, (err as Error).message);
    }

    const frontmost = raw.startsWith(`A\x1e`)
      ? raw.split("\n")[0]?.includes("true") === true
      : false;
    const rawWindows = parseRecordOutput(raw);

    const windows: BrowserWindow[] = rawWindows.map((w, i) => {
      const activeIdx0 = Math.max(0, w.activeTabIndex1 - 1);
      return {
        windowId: makeWindowId(spec.browser, w.nativeId),
        cgWindowId: null,
        title: sanitize(w.title) ?? "",
        bounds: w.bounds,
        focused: frontmost && i === 0,
        incognito: false, // Safari AppleScript does not expose private-window state.
        activeTabIndex: activeIdx0,
        tabCount: w.tabs.length,
        tabs: w.tabs.map((t, ti) => ({
          tabId: makeSafariTabId(w.nativeId, ti + 1),
          index: ti,
          url: sanitize(t.url) ?? "",
          title: sanitize(t.title) ?? "",
          active: ti === activeIdx0,
          pinned: false,
          audible: false,
          discarded: false,
        })),
      };
    });

    return { ...emptyState(pid, true), windows };
  }

  async function focusTab(tabId: string, signal?: AbortSignal): Promise<CommandResult> {
    const ref = requireSafariTab(tabId);
    const script = `
tell application "Safari"
  ${findWindowClause(ref.nativeWindowId)}
  if (count of tabs of target) < ${ref.index1} then return "not_found"
  set current tab of target to tab ${ref.index1} of target
  set index of target to 1
  activate
  return "ok"
end tell`;
    const out = (
      await runOsa(script, { appName: spec.appName, ...(signal ? { signal } : {}) })
    ).trim();
    if (out !== "ok") {
      throw new Error(
        `Tab not found — Safari handles are index-based and go stale when tabs reorder. Re-run list_tabs.`,
      );
    }
    return {
      ok: true,
      command: "focus_tab",
      browser: spec.browser,
      tabId,
      windowId: makeWindowId(spec.browser, ref.nativeWindowId),
      index: ref.index1 - 1,
    };
  }

  async function closeTab(tabId: string, signal?: AbortSignal): Promise<CommandResult> {
    const ref = requireSafariTab(tabId);
    const script = `
tell application "Safari"
  ${findWindowClause(ref.nativeWindowId)}
  if (count of tabs of target) < ${ref.index1} then return "not_found"
  close tab ${ref.index1} of target
  return "ok"
end tell`;
    const out = (
      await runOsa(script, { appName: spec.appName, ...(signal ? { signal } : {}) })
    ).trim();
    if (out !== "ok") {
      throw new Error(
        `Tab not found — Safari handles are index-based and go stale when tabs reorder. Re-run list_tabs.`,
      );
    }
    return { ok: true, command: "close_tab", browser: spec.browser, tabId };
  }

  async function openTab(input: OpenTabInput, signal?: AbortSignal): Promise<CommandResult> {
    const url = new URL(input.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`Only http(s) URLs can be opened; got "${url.protocol}".`);
    }
    const urlLit = osaQuote(url.toString());
    let winClause: string;
    if (input.windowId) {
      const wparsed = parseWindowId(input.windowId);
      if (
        !wparsed ||
        wparsed.browser !== "safari" ||
        wparsed.ext ||
        !/^\d+$/.test(wparsed.nativeId)
      ) {
        throw new Error(`windowId "${input.windowId}" is not a safari window handle.`);
      }
      winClause = findWindowClause(wparsed.nativeId);
    } else {
      winClause = `
  if (count of windows) is 0 then
    make new document
  end if
  set target to front window`;
    }
    const script = `
tell application "Safari"
  ${winClause}
  tell target to set newTab to make new tab with properties {URL:${urlLit}}
  ${input.activate ? `set current tab of target to newTab\n  set index of target to 1\n  activate` : ""}
  return "ok" & ${RS_EXPR} & (id of target as text) & ${RS_EXPR} & (index of newTab as text)
end tell`;
    const out = (
      await runOsa(script, { appName: spec.appName, ...(signal ? { signal } : {}) })
    ).trim();
    if (!out.startsWith("ok")) {
      throw new Error(`Window not found — it may have been closed. Re-run list_tabs.`);
    }
    const [, winNative, index1] = out.split("\x1e");
    return {
      ok: true,
      command: "open_tab",
      browser: spec.browser,
      ...(winNative && index1
        ? {
            tabId: makeSafariTabId(winNative, Number.parseInt(index1, 10)),
            windowId: makeWindowId(spec.browser, winNative),
            index: Number.parseInt(index1, 10) - 1,
          }
        : {}),
    };
  }

  async function moveTab(input: MoveTabInput, signal?: AbortSignal): Promise<CommandResult> {
    if (!input.allowReload) {
      throw new Error(
        `Safari's AppleScript move reloads the page (loses scroll/form/JS state). ` +
          `Pass allowReload:true to accept that, or install the Safari extension for true moves.`,
      );
    }
    const ref = requireSafariTab(input.tabId);
    let destClause: string;
    let destNativeId: string | null = null;
    if (input.newWindow) {
      destClause = `
  set dest to make new document
  set dest to front window`;
    } else if (input.targetWindowId) {
      const wparsed = parseWindowId(input.targetWindowId);
      if (
        !wparsed ||
        wparsed.browser !== "safari" ||
        wparsed.ext ||
        !/^\d+$/.test(wparsed.nativeId)
      ) {
        throw new Error(`targetWindowId "${input.targetWindowId}" is not a safari window handle.`);
      }
      destNativeId = wparsed.nativeId;
      destClause = `
  set dest to missing value
  repeat with w2 in windows
    if (id of w2 as text) is "${wparsed.nativeId}" then
      set dest to w2
    end if
  end repeat
  if dest is missing value then return "not_found"`;
    } else {
      throw new Error(`move_tab needs targetWindowId or newWindow:true.`);
    }
    // targetIndex: Safari's `move` supports `to beginning/end of tabs of dest`;
    // arbitrary positions need a second move — v1 supports end-of-window only.
    if (input.targetIndex !== undefined) {
      throw new Error(
        `Safari AppleScript moves only support appending at the end of the target window. ` +
          `Omit targetIndex, or use the extension pathway.`,
      );
    }
    const script = `
tell application "Safari"
  ${findWindowClause(ref.nativeWindowId)}
  if (count of tabs of target) < ${ref.index1} then return "not_found"
  ${destClause}
  move tab ${ref.index1} of target to end of tabs of dest
  return "ok" & ${RS_EXPR} & (id of dest as text) & ${RS_EXPR} & (count of tabs of dest)
end tell`;
    const out = (
      await runOsa(script, { appName: spec.appName, ...(signal ? { signal } : {}) })
    ).trim();
    if (!out.startsWith("ok")) {
      throw new Error(
        `Move failed — source tab or destination window not found. Re-run list_tabs for fresh handles.`,
      );
    }
    const [, destWin, destCount] = out.split("\x1e");
    const finalWin = destWin ?? destNativeId ?? "";
    const index1 = Number.parseInt(destCount ?? "1", 10);
    return {
      ok: true,
      command: "move_tab",
      browser: spec.browser,
      tabId: makeSafariTabId(finalWin, index1),
      windowId: makeWindowId(spec.browser, finalWin),
      index: index1 - 1,
    };
  }

  return {
    spec,
    probe: (signal) => probeProcess(spec.processName, signal),
    readState,
    focusTab,
    closeTab,
    openTab,
    moveTab,
  };
}
