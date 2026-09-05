/**
 * reopen — bring a closed tab back, and say honestly which kind of "back".
 *
 * Phase 5 PR-P. There are two mechanisms and they are NOT equivalent:
 *
 *   session-restore  chrome.sessions.restore(sessionId) — the browser's own
 *                    recently-closed entry. Brings the tab back WITH its
 *                    back/forward history, scroll position and (usually) form
 *                    state. Only available while the browser still holds the
 *                    entry, which is a window of minutes-to-hours it owns.
 *   reconstructed    open_tab at the recorded URL, then re-pin and re-group.
 *                    A new tab that happens to point at the same page: no
 *                    history, no scroll, nothing behind it.
 *
 * The result names which one happened. A caller that asked to undo a close and
 * silently got a fresh tab pointing at the same URL has been told a
 * half-truth, and the difference is exactly what someone notices when they
 * press Back and land nowhere.
 *
 * ONE DELIBERATE REFUSAL. chrome.sessions entries come in two shapes, tab and
 * window, and restoring a WINDOW entry brings back every tab that window held.
 * When only a window entry matches, this does NOT restore it: the caller asked
 * for one tab, and returning nine is not a more generous answer to that
 * question. It reconstructs the single tab and says a whole-window restore was
 * available, leaving that as a decision rather than a surprise.
 */

import type { BrowserId } from "@george43g/shared-types";
import type { ClosedTabRecord, ClosedTabStore } from "./closed-tabs.js";
import type { ExtensionServer } from "./ws-server.js";

export interface ReopenDeps {
  closedTabs: ClosedTabStore;
  ext: ExtensionServer | null;
  runCommand: (params: Record<string, unknown>) => Promise<unknown>;
  refresh: () => Promise<unknown>;
}

export interface ReopenResult {
  closedTabId: string;
  method: "session-restore" | "reconstructed";
  /** The one thing a caller most needs to know and cannot see afterwards. */
  historyPreserved: boolean;
  url: string;
  tabId?: string;
  windowId?: string;
  warnings: string[];
}

interface SessionRow {
  sessionId: string;
  kind: "tab" | "window";
  url: string;
  title: string;
  lastModified: number;
}

/** Recently-closed entries the browser itself still holds, newest first. */
async function recentSessions(
  ext: ExtensionServer | null,
  browser: BrowserId,
): Promise<SessionRow[]> {
  if (!ext?.isConnected(browser)) return [];
  try {
    const raw = (await ext.sendCommand(browser, "sessions", {
      action: "recent",
      maxResults: 25,
    })) as { rows?: SessionRow[] } | undefined;
    return Array.isArray(raw?.rows) ? raw.rows : [];
  } catch {
    // No sessions permission on an older installed bundle, or an API this
    // browser lacks: reconstruction is still a real answer, so degrade to it
    // rather than failing the whole reopen.
    return [];
  }
}

export async function reopenTab(
  params: Record<string, unknown>,
  deps: ReopenDeps,
): Promise<ReopenResult> {
  const closedTabId = String((params as { closedTabId?: unknown }).closedTabId ?? "");
  if (!closedTabId) throw new Error("reopen needs a closedTabId from `browser-tab closed`.");
  const rec: ClosedTabRecord | undefined = deps.closedTabs.get(closedTabId);
  if (rec === undefined) {
    throw new Error(
      `closed tab "${closedTabId}" is unknown or has aged out (BROWSER_TAB_CLOSED_TAB_TTL_MS) — ` +
        "run `browser-tab closed` for what is still reopenable.",
    );
  }

  const warnings: string[] = [];
  const rows = await recentSessions(deps.ext, rec.browser);
  const sameUrl = rows.filter((r) => r.url === rec.url);
  const tabEntry = sameUrl.find((r) => r.kind === "tab");
  const windowEntry = sameUrl.find((r) => r.kind === "window");

  if (tabEntry !== undefined) {
    const raw = (await deps.ext?.sendCommand(rec.browser, "sessions", {
      action: "restore",
      sessionId: tabEntry.sessionId,
    })) as { tabId?: number; windowId?: number } | undefined;
    await deps.refresh();
    return {
      closedTabId,
      method: "session-restore",
      historyPreserved: true,
      url: rec.url,
      ...(raw?.tabId !== undefined ? { tabId: `t:${rec.browser}:x${raw.tabId}` } : {}),
      ...(raw?.windowId !== undefined ? { windowId: `w:${rec.browser}:x${raw.windowId}` } : {}),
      warnings,
    };
  }
  if (windowEntry !== undefined) {
    warnings.push(
      "the browser holds a WHOLE-WINDOW restore for this page, not a single-tab one — " +
        "reconstructing the one tab instead; restore the window deliberately if that is what " +
        "you meant (it brings back every tab that window held).",
    );
  } else if (rows.length > 0) {
    warnings.push(
      "the browser no longer holds a recently-closed entry for this page, so its back/forward " +
        "history could not be restored.",
    );
  }

  // Reconstruct. The recorded window may itself be gone, in which case a new
  // one is the only honest destination.
  const opened = (await deps.runCommand({
    kind: "open_tab",
    url: rec.url,
    browser: rec.browser,
    ...(rec.windowGone ? { newWindow: true } : { windowId: rec.windowId }),
    activate: false,
    pinned: rec.pinned,
  })) as { tabId?: string; windowId?: string } | undefined;
  await deps.refresh();
  if (rec.groupId !== undefined) {
    warnings.push(
      `the tab was in group ${rec.groupId}${rec.groupTitle ? ` ("${rec.groupTitle}")` : ""}; ` +
        "a reconstructed tab is not re-grouped automatically — the group may no longer exist.",
    );
  }
  return {
    closedTabId,
    method: "reconstructed",
    historyPreserved: false,
    url: rec.url,
    ...(opened?.tabId !== undefined ? { tabId: opened.tabId } : {}),
    ...(opened?.windowId !== undefined ? { windowId: opened.windowId } : {}),
    warnings,
  };
}
