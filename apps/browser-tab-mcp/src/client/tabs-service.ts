/**
 * tabs-service — the single routing layer every tool goes through.
 *
 * Reads:    daemon (fresh merged state, <50ms) → direct osascript engine.
 * Commands: daemon (extension pathway when connected) → direct adapters.
 *
 * The fallback keeps every read and AppleScript-able command working with
 * no daemon at all; only extension-dependent behavior (true Chromium
 * moves, push events) needs the daemon running.
 */

import { warn } from "@george43g/robustness";
import type {
  AnnotateInput,
  AnnotateOutput,
  BrowserId,
  CloseWindowInput,
  CommandResult,
  GetPageInput,
  GetPageOutput,
  GroupTabsInput,
  HistoryOutput,
  JournalOutput,
  MoveTabInput,
  OpenTabInput,
  OpenWindowInput,
  ScreenshotInput,
  ScreenshotOutput,
  SetWindowInput,
  Snapshot,
  TabActionInput,
} from "@george43g/shared-types";
import { SnapshotSchema } from "@george43g/shared-types";
import { fakeAdapterEnabled } from "../detect/adapters/fake.js";
import { resolveWindowBounds } from "../detect/displays.js";
import { enabledBrowsers, makeAdapter, readSnapshot } from "../detect/engine.js";
import { parseTabId, parseWindowId } from "../detect/ids.js";
import { DaemonClient, DaemonUnavailableError } from "./daemon-client.js";

async function viaDaemon<T>(fn: (client: DaemonClient) => Promise<T>): Promise<T> {
  const client = new DaemonClient();
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

function browserOf(handle: string): BrowserId {
  const parsed = parseTabId(handle) ?? parseWindowId(handle);
  if (!parsed) {
    throw new Error(`Malformed handle "${handle}" — pass tabId/windowId values from list_tabs.`);
  }
  return parsed.browser;
}

/**
 * Tolerate a still-running v1 daemon after a client upgrade: a v1 snapshot
 * is re-stamped v2 and parsed so Zod defaults backfill the new fields
 * (capabilities, tabGroups, muted/frozen). v2 responses pass through
 * untouched (no re-parse on the happy path). The right long-term fix is
 * `browser-tab daemon restart`, which the doctor flags.
 */
function upgradeSnapshot(raw: unknown): Snapshot {
  const obj = raw as { version?: number } | null;
  if (obj && obj.version === 1) {
    return SnapshotSchema.parse({ ...(raw as object), version: 2 });
  }
  return raw as Snapshot;
}

export async function getSnapshot(opts: {
  browsers?: BrowserId[];
  signal?: AbortSignal;
}): Promise<Snapshot> {
  // Fixture mode must stay deterministic — never shadowed by a live daemon.
  if (fakeAdapterEnabled()) return readSnapshot(opts);
  try {
    const snapshot = upgradeSnapshot(await viaDaemon((c) => c.request<unknown>("getSnapshot")));
    if (opts.browsers) {
      const set = new Set(opts.browsers);
      return { ...snapshot, browsers: snapshot.browsers.filter((b) => set.has(b.browser)) };
    }
    return snapshot;
  } catch (err) {
    if (!(err instanceof DaemonUnavailableError)) throw err;
    warn("daemon_unreachable_falling_back", { op: "getSnapshot" });
    return readSnapshot(opts);
  }
}

async function command(
  kind: string,
  params: Record<string, unknown>,
  fallback: () => Promise<CommandResult>,
): Promise<CommandResult> {
  if (fakeAdapterEnabled()) return fallback();
  try {
    return await viaDaemon((c) => c.request<CommandResult>("command", { kind, ...params }));
  } catch (err) {
    if (!(err instanceof DaemonUnavailableError)) throw err;
    warn("daemon_unreachable_falling_back", { op: kind });
    return fallback();
  }
}

export function focusTab(tabId: string): Promise<CommandResult> {
  return command("focus_tab", { tabId }, () => makeAdapter(browserOf(tabId)).focusTab(tabId));
}

export function closeTab(tabId: string): Promise<CommandResult> {
  return command("close_tab", { tabId }, () => makeAdapter(browserOf(tabId)).closeTab(tabId));
}

export function moveTab(input: MoveTabInput): Promise<CommandResult> {
  return command("move_tab", { ...input }, () =>
    makeAdapter(browserOf(input.tabId)).moveTab(input),
  );
}

export function openTab(input: OpenTabInput): Promise<CommandResult> {
  const browser =
    input.browser ?? (input.windowId ? browserOf(input.windowId) : enabledBrowsers()[0]);
  if (!browser) throw new Error("No browser enabled.");
  return command("open_tab", { ...input, browser }, () => makeAdapter(browser).openTab(input));
}

export function tabAction(input: TabActionInput): Promise<CommandResult> {
  if (input.action === "navigate" && !input.url) {
    return Promise.reject(new Error('tab_action "navigate" requires a url.'));
  }
  return command("tab_action", { ...input }, () =>
    makeAdapter(browserOf(input.tabId)).tabAction(input),
  );
}

export function groupTabs(input: GroupTabsInput): Promise<CommandResult> {
  // Extension-only; the fallback (daemon down) has no way to manage groups.
  return command("group_tabs", { ...input }, async () => {
    throw new Error(
      "Tab groups require the browser-tab extension (Chrome-family) and a running daemon — " +
        "AppleScript can't manage tab groups.",
    );
  });
}

export function openWindow(input: OpenWindowInput): Promise<CommandResult> {
  const bounds = resolveWindowBounds(input); // display → global bounds (may throw without native)
  const browser = input.browser ?? enabledBrowsers()[0];
  if (!browser) throw new Error("No browser enabled.");
  // bounds win over state; never send both (chrome rejects the combination).
  const geometry = bounds ? { bounds } : input.state ? { state: input.state } : {};
  return command(
    "open_window",
    {
      urls: input.urls,
      browser,
      incognito: input.incognito,
      focused: input.focused,
      ...geometry,
    },
    () =>
      makeAdapter(browser).openWindow({
        urls: input.urls,
        browser,
        incognito: input.incognito,
        focused: input.focused,
        ...geometry,
      }),
  );
}

export function setWindow(input: SetWindowInput): Promise<CommandResult> {
  const bounds = resolveWindowBounds(input);
  const browser = browserOf(input.windowId);
  const geometry = bounds ? { bounds } : input.state ? { state: input.state } : {};
  const focus = input.focused !== undefined ? { focused: input.focused } : {};
  return command("set_window", { windowId: input.windowId, ...geometry, ...focus }, () =>
    makeAdapter(browser).setWindow({ windowId: input.windowId, ...geometry, ...focus }),
  );
}

export function closeWindow(input: CloseWindowInput): Promise<CommandResult> {
  return command("close_window", { ...input }, () =>
    makeAdapter(browserOf(input.windowId)).closeWindow(input),
  );
}

export interface DaemonStatus {
  reachable: boolean;
  socket?: unknown;
  [key: string]: unknown;
}

export async function daemonStatus(): Promise<Record<string, unknown>> {
  try {
    const status = await viaDaemon((c) => c.request<Record<string, unknown>>("status"));
    return { reachable: true, ...status };
  } catch (err) {
    if (!(err instanceof DaemonUnavailableError)) throw err;
    return {
      reachable: false,
      hint: "Start it with `browser-tab daemon run` (or `browser-tab daemon install` for launchd).",
    };
  }
}

export async function journal(params: Record<string, unknown>): Promise<JournalOutput> {
  const empty: JournalOutput = { view: String(params.view ?? "recent"), focus: [], nav: [] };
  // Journals are daemon-only state; fixture mode and a down daemon both yield
  // an empty result rather than an error.
  if (fakeAdapterEnabled()) return empty;
  try {
    return await viaDaemon((c) => c.request<JournalOutput>("journal", params));
  } catch (err) {
    if (!(err instanceof DaemonUnavailableError)) throw err;
    warn("daemon_unreachable_falling_back", { op: "journal" });
    return empty;
  }
}

/**
 * Query global browsing history. Daemon-only (the extension/sqlite sources
 * live there); fixture mode and a down daemon both yield an empty result
 * rather than an error, like `journal`.
 */
export async function history(params: Record<string, unknown>): Promise<HistoryOutput> {
  const empty: HistoryOutput = { rows: [], truncated: false };
  if (fakeAdapterEnabled()) return empty;
  try {
    return await viaDaemon((c) => c.request<HistoryOutput>("history", params));
  } catch (err) {
    if (!(err instanceof DaemonUnavailableError)) throw err;
    warn("daemon_unreachable_falling_back", { op: "history" });
    return empty;
  }
}

/**
 * Extract page content/state. Extension-only + daemon-only — there's no
 * AppleScript path and the cache lives in the daemon, so fixture mode and a
 * down daemon both surface an actionable error (not a silent empty).
 */
export async function getPage(input: GetPageInput): Promise<GetPageOutput> {
  if (fakeAdapterEnabled()) {
    throw new Error(
      "Page content extraction requires the daemon and the browser extension — not available in fixture mode.",
    );
  }
  try {
    return await viaDaemon((c) => c.request<GetPageOutput>("getPage", { ...input }));
  } catch (err) {
    if (err instanceof DaemonUnavailableError) {
      throw new Error(
        "Page content extraction requires the daemon. Start it with `browser-tab daemon run`.",
      );
    }
    throw err;
  }
}

/** Read/write a URL-keyed annotation. Daemon-only (the store lives there). */
export async function annotate(input: AnnotateInput): Promise<AnnotateOutput> {
  if (fakeAdapterEnabled()) {
    throw new Error("Annotations require the daemon — not available in fixture mode.");
  }
  try {
    return await viaDaemon((c) => c.request<AnnotateOutput>("annotate", { ...input }));
  } catch (err) {
    if (err instanceof DaemonUnavailableError) {
      throw new Error("Annotations require the daemon. Start it with `browser-tab daemon run`.");
    }
    throw err;
  }
}

/**
 * Capture a tab (tier 1) or window (tier 2) screenshot. Daemon-only — the
 * capture path (extension captureVisibleTab / `screencapture`) and the shot
 * cache both live in the daemon, so fixture mode and a down daemon both
 * surface an actionable error rather than a silent empty.
 */
export async function screenshot(input: ScreenshotInput): Promise<ScreenshotOutput> {
  if (fakeAdapterEnabled()) {
    throw new Error(
      "Screenshots require the daemon and (tier 'tab') the browser extension — not available in fixture mode.",
    );
  }
  try {
    return await viaDaemon((c) => c.request<ScreenshotOutput>("screenshot", { ...input }));
  } catch (err) {
    if (err instanceof DaemonUnavailableError) {
      throw new Error("Screenshots require the daemon. Start it with `browser-tab daemon run`.");
    }
    throw err;
  }
}

export async function refreshDaemon(): Promise<Snapshot | null> {
  try {
    return await viaDaemon((c) => c.request<Snapshot>("refresh"));
  } catch (err) {
    if (!(err instanceof DaemonUnavailableError)) throw err;
    return null;
  }
}
