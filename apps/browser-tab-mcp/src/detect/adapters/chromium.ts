/**
 * Chromium-family adapter — Chrome, Chromium, Brave share one AppleScript
 * dictionary; only the application name differs.
 *
 * Read: single AppleScript call dumps every window (id, bounds, active tab
 * index, mode, title) and tab (id, URL, title) in the RS record format
 * (ported from wm-stack's browser_tabs.sh, extended with bounds/mode).
 *
 * Commands: focus/close/open are AppleScript-able. moveTab is NOT — the
 * only AppleScript "move" is close+reopen, which loses session state
 * (scroll, forms, back/forward, JS heap). True moves arrive with the
 * extension (chrome.tabs.move) in the daemon pathway.
 */

import { sanitize } from "@george43g/mcp-kit";
import type {
  BrowserState,
  BrowserWindow,
  CloseWindowInput,
  CommandResult,
  MoveTabInput,
  OpenTabInput,
  OpenWindowInput,
  SetWindowInput,
  TabActionInput,
  WindowBounds,
} from "@george43g/shared-types";
import { makeChromiumTabId, makeWindowId, parseTabId, parseWindowId } from "../ids.js";
import { osaQuote, probeProcess, runOsa, runOsaRead } from "../osascript.js";
import { parseRecordOutput } from "../parse.js";
import { focusWindowState } from "./focus-state.js";
import type { AdapterSpec, BrowserAdapter, FocusTabOptions } from "./types.js";

/** WindowBounds {x,y,w,h} → the AppleScript {left, top, right, bottom} list. */
function boundsRect(b: WindowBounds): string {
  return `{${Math.round(b.x)}, ${Math.round(b.y)}, ${Math.round(b.x + b.w)}, ${Math.round(b.y + b.h)}}`;
}

/** http(s) validation shared by navigate/open — throws on anything else. */
function httpUrl(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Only http(s) URLs are allowed; got "${url.protocol}".`);
  }
  return url.toString();
}

export const CHROMIUM_SPECS: readonly AdapterSpec[] = [
  {
    browser: "chrome",
    appName: "Google Chrome",
    bundleId: "com.google.Chrome",
    processName: "Google Chrome",
  },
  {
    browser: "brave",
    appName: "Brave Browser",
    bundleId: "com.brave.Browser",
    processName: "Brave Browser",
  },
  {
    browser: "chromium",
    appName: "Chromium",
    bundleId: "org.chromium.Chromium",
    processName: "Chromium",
  },
];

const RS_EXPR = `(character id 30)`;

function readScript(appName: string): string {
  // First line: "A" <RS> frontmost — lets us mark the focused window
  // (AppleScript window order is front-to-back, so window 1 is frontmost).
  return `
tell application ${osaQuote(appName)}
  set rs to ${RS_EXPR}
  set out to "A" & rs & (frontmost as text) & linefeed
  repeat with w in windows
    try
      set b to bounds of w
      set out to out & "W" & rs & (id of w as text) & rs & (item 1 of b) & rs & (item 2 of b) & rs & (item 3 of b) & rs & (item 4 of b) & rs & (active tab index of w) & rs & (mode of w) & rs & (title of w) & linefeed
      repeat with t in tabs of w
        try
          set out to out & "T" & rs & (id of t as text) & rs & (URL of t) & rs & (title of t) & linefeed
        end try
      end repeat
    end try
  end repeat
  return out
end tell`;
}

function requireNumeric(value: string, what: string): string {
  if (!/^\d+$/.test(value)) throw new Error(`Malformed ${what}: not a native numeric id.`);
  return value;
}

export function makeChromiumAdapter(spec: AdapterSpec): BrowserAdapter {
  const emptyState = (pid: number | null, running: boolean, error?: string): BrowserState => ({
    browser: spec.browser,
    bundleId: spec.bundleId,
    pid,
    running,
    extensionConnected: false,
    dataSource: "applescript",
    ...(error !== undefined ? { error } : {}),
    tabGroups: [],
    windows: [],
  });

  async function readState(signal?: AbortSignal): Promise<BrowserState> {
    const { running, pid } = await probeProcess(spec.processName, signal);
    if (!running) return emptyState(null, false);

    let raw: string;
    try {
      raw = await runOsaRead(readScript(spec.appName), {
        appName: spec.appName,
        ...(signal ? { signal } : {}),
      });
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
        incognito: w.mode === "incognito",
        activeTabIndex: activeIdx0,
        tabCount: w.tabs.length,
        tabs: w.tabs.map((t, ti) => ({
          tabId: makeChromiumTabId(spec.browser, t.nativeId),
          index: ti,
          url: sanitize(t.url) ?? "",
          title: sanitize(t.title) ?? "",
          active: ti === activeIdx0,
          pinned: false,
          audible: false,
          discarded: false,
          muted: false,
          frozen: false,
        })),
      };
    });

    return { ...emptyState(pid, true), windows };
  }

  async function focusTab(
    tabId: string,
    opts?: FocusTabOptions,
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    const parsed = parseTabId(tabId);
    if (!parsed || parsed.browser !== spec.browser || !parsed.nativeId || parsed.ext) {
      throw new Error(`tabId "${tabId}" is not a ${spec.browser} tab handle from list_tabs.`);
    }
    const nid = requireNumeric(parsed.nativeId, "tabId");
    const raiseWindow = opts?.raiseWindow !== false;
    // `set minimized … to false` comes FIRST and is the whole point of this
    // block: the extension pathway un-minimizes as a side effect of
    // windows.update({focused:true}), so without it the two pathways gave the
    // same call two different outcomes (a focused tab in a still-minimized
    // window). Raising a window that is still minimized is a no-op, so the
    // order is load-bearing, not cosmetic.
    const raiseLines = raiseWindow
      ? `        set minimized of w to false
        set index of w to 1
        activate`
      : "";
    const script = `
tell application ${osaQuote(spec.appName)}
  repeat with w in windows
    set i to 0
    repeat with t in tabs of w
      set i to i + 1
      if (id of t as text) is "${nid}" then
        set wasMin to minimized of w
        set active tab index of w to i
${raiseLines}
        return "ok" & ${RS_EXPR} & (id of w as text) & ${RS_EXPR} & i & ${RS_EXPR} & (wasMin as text) & ${RS_EXPR} & (minimized of w as text) & ${RS_EXPR} & (index of w as text)
      end if
    end repeat
  end repeat
  return "not_found"
end tell`;
    const out = (
      await runOsa(script, { appName: spec.appName, ...(signal ? { signal } : {}) })
    ).trim();
    if (!out.startsWith("ok")) {
      throw new Error(
        `Tab not found — it may have been closed. Re-run list_tabs for fresh handles.`,
      );
    }
    const [, winNative, index1, wasMin, isMin, winIndex] = out.split("\x1e");
    return {
      ok: true,
      command: "focus_tab",
      browser: spec.browser,
      tabId,
      ...(winNative ? { windowId: makeWindowId(spec.browser, winNative) } : {}),
      ...(index1 ? { index: Number.parseInt(index1, 10) - 1 } : {}),
      ...focusWindowState({ wasMin, isMin, winIndex }),
    };
  }

  async function closeTab(tabId: string, signal?: AbortSignal): Promise<CommandResult> {
    const parsed = parseTabId(tabId);
    if (!parsed || parsed.browser !== spec.browser || !parsed.nativeId || parsed.ext) {
      throw new Error(`tabId "${tabId}" is not a ${spec.browser} tab handle from list_tabs.`);
    }
    const nid = requireNumeric(parsed.nativeId, "tabId");
    const script = `
tell application ${osaQuote(spec.appName)}
  repeat with w in windows
    repeat with t in tabs of w
      if (id of t as text) is "${nid}" then
        close t
        return "ok"
      end if
    end repeat
  end repeat
  return "not_found"
end tell`;
    const out = (
      await runOsa(script, { appName: spec.appName, ...(signal ? { signal } : {}) })
    ).trim();
    if (out !== "ok") {
      throw new Error(
        `Tab not found — it may already be closed. Re-run list_tabs for fresh handles.`,
      );
    }
    return { ok: true, command: "close_tab", browser: spec.browser, tabId };
  }

  async function openTab(input: OpenTabInput, signal?: AbortSignal): Promise<CommandResult> {
    const url = new URL(input.url); // throws on garbage
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`Only http(s) URLs can be opened; got "${url.protocol}".`);
    }
    const urlLit = osaQuote(url.toString());
    let winClause: string;
    if (input.windowId) {
      const wparsed = parseWindowId(input.windowId);
      if (!wparsed || wparsed.browser !== spec.browser || wparsed.ext) {
        throw new Error(`windowId "${input.windowId}" is not a ${spec.browser} window handle.`);
      }
      const wid = requireNumeric(wparsed.nativeId, "windowId");
      winClause = `
  set target to missing value
  repeat with w in windows
    if (id of w as text) is "${wid}" then
      set target to w
    end if
  end repeat
  if target is missing value then return "not_found"`;
    } else {
      winClause = `
  if (count of windows) is 0 then
    make new window
  end if
  set target to front window`;
    }
    const script = `
tell application ${osaQuote(spec.appName)}
  ${winClause}
  set newTab to make new tab at end of tabs of target with properties {URL:${urlLit}}
  ${input.activate ? `set active tab index of target to (count of tabs of target)\n  set index of target to 1\n  activate` : ""}
  return "ok" & ${RS_EXPR} & (id of target as text) & ${RS_EXPR} & (id of newTab as text) & ${RS_EXPR} & (count of tabs of target)
end tell`;
    const out = (
      await runOsa(script, { appName: spec.appName, ...(signal ? { signal } : {}) })
    ).trim();
    if (!out.startsWith("ok")) {
      throw new Error(`Window not found — it may have been closed. Re-run list_tabs.`);
    }
    const [, winNative, tabNative, count] = out.split("\x1e");
    return {
      ok: true,
      command: "open_tab",
      browser: spec.browser,
      ...(tabNative ? { tabId: makeChromiumTabId(spec.browser, tabNative) } : {}),
      ...(winNative ? { windowId: makeWindowId(spec.browser, winNative) } : {}),
      ...(count ? { index: Number.parseInt(count, 10) - 1 } : {}),
    };
  }

  async function moveTab(_input: MoveTabInput): Promise<CommandResult> {
    throw new Error(
      `${spec.appName} tabs cannot be moved via AppleScript without losing session state ` +
        `(scroll, forms, history). Run the daemon with the browser-tab extension installed — ` +
        `the extension pathway uses chrome.tabs.move, which preserves everything.`,
    );
  }

  function tabById(nid: string, verb: string): string {
    return `
tell application ${osaQuote(spec.appName)}
  repeat with w in windows
    repeat with t in tabs of w
      if (id of t as text) is "${nid}" then
        ${verb}
        return "ok"
      end if
    end repeat
  end repeat
  return "not_found"
end tell`;
  }

  async function tabAction(input: TabActionInput, signal?: AbortSignal): Promise<CommandResult> {
    const parsed = parseTabId(input.tabId);
    if (!parsed || parsed.browser !== spec.browser || !parsed.nativeId || parsed.ext) {
      throw new Error(`tabId "${input.tabId}" is not a ${spec.browser} tab handle from list_tabs.`);
    }
    const nid = requireNumeric(parsed.nativeId, "tabId");
    let verb: string;
    switch (input.action) {
      case "navigate": {
        if (!input.url) throw new Error("navigate requires a url.");
        verb = `set URL of t to ${osaQuote(httpUrl(input.url))}`;
        break;
      }
      case "reload":
        verb = `reload t`;
        break;
      case "back":
        verb = `go back t`;
        break;
      case "forward":
        verb = `go forward t`;
        break;
      default:
        throw new Error(
          `Action "${input.action}" isn't available for ${spec.appName} via AppleScript — ` +
            `mute/pin/discard/duplicate need the browser-tab extension. Connect it, then re-run list_tabs.`,
        );
    }
    const out = (
      await runOsa(tabById(nid, verb), { appName: spec.appName, ...(signal ? { signal } : {}) })
    ).trim();
    if (out !== "ok") {
      throw new Error(
        `Tab not found — it may have been closed. Re-run list_tabs for fresh handles.`,
      );
    }
    return {
      ok: true,
      command: "tab_action",
      browser: spec.browser,
      tabId: input.tabId,
      payload: { action: input.action },
    };
  }

  /** Reject window states AppleScript can't express so the tool degrades cleanly. */
  function stateLines(state: string | undefined, ref: string): string {
    if (state === "minimized") return `  set minimized of ${ref} to true`;
    if (state === "normal") return `  set minimized of ${ref} to false`;
    if (state === "maximized" || state === "fullscreen") {
      throw new Error(
        `Window state "${state}" isn't settable for ${spec.appName} via AppleScript ` +
          `(supported: normal, minimized). Use the browser-tab extension for maximized/fullscreen.`,
      );
    }
    return "";
  }

  async function openWindow(input: OpenWindowInput, signal?: AbortSignal): Promise<CommandResult> {
    const urls = input.urls.map(httpUrl);
    const first = urls[0];
    if (!first) throw new Error("open_window requires at least one url.");
    const modeProp = input.incognito ? ` with properties {mode:"incognito"}` : "";
    const extraTabs = urls
      .slice(1)
      .map((u) => `  make new tab at end of tabs of w with properties {URL:${osaQuote(u)}}`)
      .join("\n");
    const geometry = input.bounds ? `  set bounds of w to ${boundsRect(input.bounds)}` : "";
    const stateLine = stateLines(input.state, "w");
    const focusLine =
      (input.focused ?? true) && input.state !== "minimized"
        ? `  set index of w to 1\n  activate`
        : "";
    const script = `
tell application ${osaQuote(spec.appName)}
  set w to make new window${modeProp}
  set URL of active tab of w to ${osaQuote(first)}
${extraTabs}
${geometry}
${stateLine}
${focusLine}
  return "ok" & ${RS_EXPR} & (id of w as text)
end tell`;
    const out = (
      await runOsa(script, { appName: spec.appName, ...(signal ? { signal } : {}) })
    ).trim();
    if (!out.startsWith("ok")) throw new Error(`Failed to open ${spec.appName} window.`);
    const [, winNative] = out.split("\x1e");
    return {
      ok: true,
      command: "open_window",
      browser: spec.browser,
      ...(winNative ? { windowId: makeWindowId(spec.browser, winNative) } : {}),
      payload: { tabCount: urls.length },
    };
  }

  function findWindowById(wid: string, body: string): string {
    return `
tell application ${osaQuote(spec.appName)}
  set target to missing value
  repeat with w in windows
    if (id of w as text) is "${wid}" then set target to w
  end repeat
  if target is missing value then return "not_found"
${body}
  return "ok"
end tell`;
  }

  function requireChromiumWindow(windowId: string): string {
    const wparsed = parseWindowId(windowId);
    if (!wparsed || wparsed.browser !== spec.browser || wparsed.ext) {
      throw new Error(
        `windowId "${windowId}" is not a ${spec.browser} window handle from list_tabs.`,
      );
    }
    return requireNumeric(wparsed.nativeId, "windowId");
  }

  async function setWindow(input: SetWindowInput, signal?: AbortSignal): Promise<CommandResult> {
    const wid = requireChromiumWindow(input.windowId);
    const lines: string[] = [];
    if (input.bounds) lines.push(`  set bounds of target to ${boundsRect(input.bounds)}`);
    const stateLine = stateLines(input.state, "target");
    if (stateLine) lines.push(stateLine);
    if (input.focused) lines.push(`  set index of target to 1\n  activate`);
    if (lines.length === 0) {
      throw new Error("set_window needs at least one of bounds, display, state, focused.");
    }
    const out = (
      await runOsa(findWindowById(wid, lines.join("\n")), {
        appName: spec.appName,
        ...(signal ? { signal } : {}),
      })
    ).trim();
    if (out !== "ok")
      throw new Error(`Window not found — it may have been closed. Re-run list_tabs.`);
    return { ok: true, command: "set_window", browser: spec.browser, windowId: input.windowId };
  }

  async function closeWindow(
    input: CloseWindowInput,
    signal?: AbortSignal,
  ): Promise<CommandResult> {
    const wid = requireChromiumWindow(input.windowId);
    const out = (
      await runOsa(findWindowById(wid, `  close target`), {
        appName: spec.appName,
        ...(signal ? { signal } : {}),
      })
    ).trim();
    if (out !== "ok")
      throw new Error(`Window not found — it may already be closed. Re-run list_tabs.`);
    return { ok: true, command: "close_window", browser: spec.browser, windowId: input.windowId };
  }

  return {
    spec,
    probe: (signal) => probeProcess(spec.processName, signal),
    readState,
    focusTab,
    closeTab,
    openTab,
    moveTab,
    tabAction,
    openWindow,
    setWindow,
    closeWindow,
  };
}
