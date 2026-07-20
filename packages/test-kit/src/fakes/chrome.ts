/**
 * A `chrome`-shaped fake for driving extension-core / connector code under
 * Node. Models the `@types/chrome` surface the code actually touches — window
 * & tab APIs (+ the 8 tab event registries `wireEvents` attaches), runtime
 * messaging, storage.local, and alarms — NOT any app helper (importing an app
 * would be a cycle).
 *
 * Returns a handle: assign the namespace with `restore()` to undo it, program
 * `windows.getAll` via `setWindows`, fire a wired listener with `emit`, grab a
 * registered listener with `listener` (e.g. the runtime.onMessage handler), and
 * inspect recorded call args via `.calls` and stored values via `.storage`.
 * Omit `alarms` (`withAlarms: false`) to simulate Safari.
 */

import type { ChromeWindowLike } from "../factories/chrome-api.js";

type AnyFn = (...args: unknown[]) => unknown;

/** Default window id `windows.update`/`tabs.update` report back. */
const DEFAULT_WINDOW_ID = 7;

export interface FakeChromeConfig {
  /** Namespace to install onto globalThis. Default "chrome". */
  namespace?: "chrome" | "browser";
  /** Initial windows `windows.getAll` returns. */
  windows?: ChromeWindowLike[];
  /** `runtime.getManifest().version`. Default "0.0.0-test". */
  version?: string;
  /** Seed for `storage.local`. */
  storage?: Record<string, unknown>;
  /** Include `chrome.alarms`. Default true; set false to simulate Safari. */
  withAlarms?: boolean;
}

export interface FakeChrome {
  /**
   * The fake namespace object — ALSO installed on `globalThis[namespace]` by
   * `installFakeChrome`, so most tests never touch this directly (extension
   * code resolves the global via the `api` proxy). Typed `unknown` so test-kit
   * stays self-contained: consumers don't need `@types/chrome` to typecheck it.
   * Cast to `typeof chrome` at the use site if you need the typed surface.
   */
  chrome: unknown;
  /** Restore the previous globalThis namespace value. */
  restore(): void;
  /** Reprogram what `windows.getAll` returns. */
  setWindows(windows: ChromeWindowLike[]): void;
  /** Fire every listener registered for a dotted event name. */
  emit(event: string, ...args: unknown[]): void;
  /** First listener registered for a dotted event name (e.g. "runtime.onMessage"). */
  listener(event: string): AnyFn | undefined;
  /** Count of listeners registered for a dotted event name. */
  listenerCount(event: string): number;
  /** Backing store for storage.local. */
  storage: Map<string, unknown>;
  /** Recorded call args, keyed by dotted method path (e.g. "tabs.move"). */
  calls: Record<string, unknown[][]>;
}

export function installFakeChrome(config: FakeChromeConfig = {}): FakeChrome {
  const namespace = config.namespace ?? "chrome";
  const withAlarms = config.withAlarms ?? true;
  let windows: ChromeWindowLike[] = config.windows ?? [];
  let nextWindowId = 900;

  const storage = new Map<string, unknown>(Object.entries(config.storage ?? {}));
  const calls: Record<string, unknown[][]> = {};
  const listeners = new Map<string, AnyFn[]>();

  const record = (name: string, args: unknown[]): void => {
    let list = calls[name];
    if (!list) {
      list = [];
      calls[name] = list;
    }
    list.push(args);
  };
  const listFor = (name: string): AnyFn[] => {
    const existing = listeners.get(name);
    if (existing) return existing;
    const created: AnyFn[] = [];
    listeners.set(name, created);
    return created;
  };
  const makeEvent = (name: string) => ({
    addListener(fn: AnyFn): void {
      listFor(name).push(fn);
      record(`${name}.addListener`, [fn]);
    },
    removeListener(fn: AnyFn): void {
      const list = listFor(name);
      const idx = list.indexOf(fn);
      if (idx >= 0) list.splice(idx, 1);
    },
    hasListener(fn: AnyFn): boolean {
      return listFor(name).includes(fn);
    },
  });

  const tabsEvents = [
    "onCreated",
    "onRemoved",
    "onUpdated",
    "onMoved",
    "onActivated",
    "onAttached",
    "onDetached",
    "onReplaced",
  ] as const;

  const fake = {
    windows: {
      getAll: (query?: unknown) => {
        record("windows.getAll", [query]);
        return Promise.resolve(windows);
      },
      create: (createData?: { tabId?: number }) => {
        record("windows.create", [createData]);
        return Promise.resolve({ id: nextWindowId++, tabs: [] });
      },
      update: (windowId: number, info?: unknown) => {
        record("windows.update", [windowId, info]);
        return Promise.resolve({ id: windowId });
      },
      onCreated: makeEvent("windows.onCreated"),
      onRemoved: makeEvent("windows.onRemoved"),
      onFocusChanged: makeEvent("windows.onFocusChanged"),
    },
    tabs: {
      create: (props: { url?: string; active?: boolean; windowId?: number }) => {
        record("tabs.create", [props]);
        return Promise.resolve({
          id: 9999,
          windowId: props.windowId ?? DEFAULT_WINDOW_ID,
          index: 0,
        });
      },
      move: (tabId: number, moveProps: { windowId?: number; index?: number }) => {
        record("tabs.move", [tabId, moveProps]);
        return Promise.resolve({ id: tabId, windowId: moveProps.windowId, index: moveProps.index });
      },
      update: (tabId: number, props?: unknown) => {
        record("tabs.update", [tabId, props]);
        return Promise.resolve({ id: tabId, windowId: DEFAULT_WINDOW_ID });
      },
      remove: (tabId: number) => {
        record("tabs.remove", [tabId]);
        return Promise.resolve();
      },
      ...Object.fromEntries(tabsEvents.map((name) => [name, makeEvent(`tabs.${name}`)])),
    },
    runtime: {
      getManifest: () => ({ version: config.version ?? "0.0.0-test", manifest_version: 3 }),
      getURL: (path: string) => `chrome-extension://fake/${path}`,
      openOptionsPage: () => {
        record("runtime.openOptionsPage", []);
        return Promise.resolve();
      },
      onMessage: makeEvent("runtime.onMessage"),
      onStartup: makeEvent("runtime.onStartup"),
      onInstalled: makeEvent("runtime.onInstalled"),
    },
    storage: {
      local: {
        get: (keysOrDefaults?: Record<string, unknown> | string | string[]) => {
          record("storage.local.get", [keysOrDefaults]);
          const stored = Object.fromEntries(storage);
          if (
            keysOrDefaults &&
            typeof keysOrDefaults === "object" &&
            !Array.isArray(keysOrDefaults)
          ) {
            return Promise.resolve({ ...keysOrDefaults, ...stored });
          }
          return Promise.resolve(stored);
        },
        set: (items: Record<string, unknown>) => {
          record("storage.local.set", [items]);
          for (const [key, value] of Object.entries(items)) storage.set(key, value);
          return Promise.resolve();
        },
      },
      onChanged: makeEvent("storage.onChanged"),
    },
    ...(withAlarms
      ? {
          alarms: {
            create: (name: string, info?: unknown) => {
              record("alarms.create", [name, info]);
            },
            onAlarm: makeEvent("alarms.onAlarm"),
          },
        }
      : {}),
  };

  const holder = globalThis as Record<string, unknown>;
  const hadPrev = namespace in holder;
  const prev = holder[namespace];
  holder[namespace] = fake;

  return {
    chrome: fake,
    restore(): void {
      if (hadPrev) holder[namespace] = prev;
      else delete holder[namespace];
    },
    setWindows(next: ChromeWindowLike[]): void {
      windows = next;
    },
    emit(event: string, ...args: unknown[]): void {
      for (const fn of listFor(event)) fn(...args);
    },
    listener(event: string): AnyFn | undefined {
      return listFor(event)[0];
    },
    listenerCount(event: string): number {
      return listFor(event).length;
    },
    storage,
    calls,
  };
}
