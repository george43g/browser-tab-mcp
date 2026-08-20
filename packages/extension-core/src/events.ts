import { redactUrlUserinfo } from "@george43g/shared-types";
/**
 * Tab/window event wiring — every relevant event funnels into one
 * debounced onChange callback (the socket layer replies with a fresh full
 * snapshot; the daemon does the diffing).
 */

import { api } from "./runtime.js";

type ZeroArgEvent = { addListener?: (fn: () => void) => void } | undefined;

/** An immediate focus/navigation frame — native chrome ids; the daemon
 *  converts to handles and journals it. */
export interface ExtEventInput {
  kind: "focus" | "nav";
  windowId?: number;
  tabId?: number;
  url?: string;
  transition?: string;
}

export function wireEvents(
  onChange: () => void,
  onEvent?: (frame: ExtEventInput) => void,
  onActivated?: (info: { tabId: number; windowId: number }) => void,
): void {
  // A zero-arg handler is assignable to every chrome event callback shape.
  const handler = () => onChange();
  api.tabs.onCreated.addListener(handler);
  api.tabs.onRemoved.addListener(handler);
  api.tabs.onUpdated.addListener(handler);
  api.tabs.onMoved.addListener(handler);
  api.tabs.onActivated.addListener(handler);
  api.tabs.onAttached.addListener(handler);
  api.tabs.onDetached.addListener(handler);
  api.tabs.onReplaced.addListener(handler);
  api.windows.onCreated.addListener(handler);
  api.windows.onRemoved.addListener(handler);
  api.windows.onFocusChanged.addListener(handler);
  // Tab-group changes — Chrome-family only; guarded so Safari (no tabGroups
  // API) doesn't throw at wire time.
  const tabGroups = (api as unknown as { tabGroups?: Record<string, ZeroArgEvent> }).tabGroups;
  if (tabGroups) {
    for (const ev of ["onCreated", "onUpdated", "onMoved", "onRemoved"] as const) {
      tabGroups[ev]?.addListener?.(handler);
    }
  }
  if (onEvent || onActivated) wireEventFrames(onEvent, onActivated);
}

interface WebNavDetails {
  tabId: number;
  url: string;
  frameId: number;
  transitionType?: string;
}

/** Attach the immediate focus/nav frame emitters (in addition to the
 *  debounced snapshot handler above). `onActivated` also feeds the blur
 *  capturer, which tracks prev-active tabs on every switch. */
function wireEventFrames(
  onEvent?: (frame: ExtEventInput) => void,
  onActivated?: (info: { tabId: number; windowId: number }) => void,
): void {
  api.windows.onFocusChanged.addListener((windowId: number) => {
    // -1 (WINDOW_ID_NONE) = focus left all browser windows; skip.
    if (typeof windowId === "number" && windowId >= 0) onEvent?.({ kind: "focus", windowId });
  });
  api.tabs.onActivated.addListener((info: { tabId: number; windowId: number }) => {
    if (info && typeof info.tabId === "number") {
      onActivated?.(info);
      onEvent?.({ kind: "focus", tabId: info.tabId, windowId: info.windowId });
    }
  });
  const webNav = (
    api as unknown as {
      webNavigation?: { onCommitted?: { addListener?: (fn: (d: WebNavDetails) => void) => void } };
    }
  ).webNavigation;
  webNav?.onCommitted?.addListener?.((details: WebNavDetails) => {
    if (details.frameId !== 0) return; // top frame only
    onEvent?.({
      kind: "nav",
      tabId: details.tabId,
      url: redactUrlUserinfo(details.url),
      ...(details.transitionType ? { transition: details.transitionType } : {}),
    });
  });
}

export function debounce(fn: () => void, waitMs: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, waitMs);
  };
}
