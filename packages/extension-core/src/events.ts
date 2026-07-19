/**
 * Tab/window event wiring — every relevant event funnels into one
 * debounced onChange callback (the socket layer replies with a fresh full
 * snapshot; the daemon does the diffing).
 */

import { api } from "./runtime.js";

export function wireEvents(onChange: () => void): void {
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
