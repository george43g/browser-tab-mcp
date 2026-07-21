/**
 * Runtime capability probe — feature-detects what this browser's
 * WebExtension surface can actually do, so the daemon and consumers never
 * hardcode Chrome-vs-Safari-vs-version compat. Reported in `hello`.
 *
 * API-backed capabilities are probed by function existence; a couple of
 * field-backed ones (frozen, lastAccessed) are probed against a sample
 * tab, since Safari simply omits those fields.
 */

import type { Capabilities } from "@george43g/shared-types";
import { api } from "./runtime.js";

interface ApiSurface {
  tabs?: Record<string, unknown>;
  windows?: Record<string, unknown>;
  tabGroups?: { query?: unknown };
  history?: { search?: unknown };
  scripting?: { executeScript?: unknown };
  webNavigation?: { onCommitted?: unknown };
}

const isFn = (obj: Record<string, unknown> | undefined, key: string): boolean =>
  typeof obj?.[key] === "function";

export function probeCapabilities(sampleTab?: Record<string, unknown>): Capabilities {
  const surface = api as unknown as ApiSurface;
  const tabs = surface.tabs;
  const windows = surface.windows;
  const hasField = (key: string): boolean => sampleTab !== undefined && key in sampleTab;
  return {
    audible: true, // Chrome-family + Safari 14+
    muted: isFn(tabs, "update"), // muted written via tabs.update({ muted })
    discarded: isFn(tabs, "discard"),
    discard: isFn(tabs, "discard"),
    frozen: hasField("frozen"),
    tabGroups: typeof surface.tabGroups?.query === "function",
    lastAccessed: hasField("lastAccessed"),
    navigate: isFn(tabs, "update"),
    reload: isFn(tabs, "reload"),
    backForward: isFn(tabs, "goBack") && isFn(tabs, "goForward"),
    duplicate: isFn(tabs, "duplicate"),
    openWindow: isFn(windows, "create"),
    setWindowBounds: isFn(windows, "update"),
    closeWindow: isFn(windows, "remove"),
    focusEvents: true,
    navEvents: surface.webNavigation?.onCommitted !== undefined,
    contentExtraction: typeof surface.scripting?.executeScript === "function",
    captureVisibleTab: isFn(tabs, "captureVisibleTab"),
    history: typeof surface.history?.search === "function",
  };
}
