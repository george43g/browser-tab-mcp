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
  BrowserId,
  CommandResult,
  MoveTabInput,
  OpenTabInput,
  Snapshot,
} from "@george43g/shared-types";
import { fakeAdapterEnabled } from "../detect/adapters/fake.js";
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

export async function getSnapshot(opts: {
  browsers?: BrowserId[];
  signal?: AbortSignal;
}): Promise<Snapshot> {
  // Fixture mode must stay deterministic — never shadowed by a live daemon.
  if (fakeAdapterEnabled()) return readSnapshot(opts);
  try {
    const snapshot = await viaDaemon((c) => c.request<Snapshot>("getSnapshot"));
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

export async function refreshDaemon(): Promise<Snapshot | null> {
  try {
    return await viaDaemon((c) => c.request<Snapshot>("refresh"));
  } catch (err) {
    if (!(err instanceof DaemonUnavailableError)) throw err;
    return null;
  }
}
