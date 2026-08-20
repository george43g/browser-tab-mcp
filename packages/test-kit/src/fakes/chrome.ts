/**
 * A `chrome`-shaped fake for driving extension-core / connector code under
 * Node. Models the `@types/chrome` surface the code actually touches — window,
 * tab & tab-group APIs (+ the tab/tabGroups/webNavigation event registries the
 * connector wires), runtime messaging, storage.local, scripting, history, and
 * alarms — NOT any app helper (importing an app would be a cycle).
 *
 * Returns a handle: assign the namespace with `restore()` to undo it, program
 * `windows.getAll` via `setWindows`, fire a wired listener with `emit`, grab a
 * registered listener with `listener` (e.g. the runtime.onMessage handler), and
 * inspect recorded call args via `.calls` and stored values via `.storage`.
 *
 * `profile` shapes which capability APIs exist so the runtime capability probe
 * reports the right map: "chrome" (default) exposes everything; "safari" omits
 * the APIs Safari lacks (tabGroups, tabs.discard, history). `withAlarms:false`
 * additionally drops chrome.alarms (Safari's MV3 service worker).
 */

import type { ChromeTabGroupLike, ChromeWindowLike } from "../factories/chrome-api.js";

type AnyFn = (...args: unknown[]) => unknown;

/** Default window id `windows.update`/`tabs.update` report back. */
const DEFAULT_WINDOW_ID = 7;

export interface FakeChromeConfig {
  /** Namespace to install onto globalThis. Default "chrome". */
  namespace?: "chrome" | "browser";
  /** Which browser's capability surface to model. Default "chrome". */
  profile?: "chrome" | "safari";
  /** Initial windows `windows.getAll` returns. */
  windows?: ChromeWindowLike[];
  /** Tab groups `tabGroups.query` returns (chrome profile only). */
  groups?: ChromeTabGroupLike[];
  /** `runtime.getManifest().version`. Default "0.0.0-test". */
  version?: string;
  /** Seed for `storage.local`. */
  storage?: Record<string, unknown>;
  /** Include `chrome.alarms`. Default true; set false to simulate Safari. */
  withAlarms?: boolean;
  /** What `windows.get` reports before any state update lands. Default "normal". */
  initialWindowState?: string;
  /**
   * How many `windows.update({state})` calls are accepted and then silently
   * reverted, modelling a pending geometry update re-asserting the old state.
   * Default 0 (state applies immediately).
   */
  stateClobbers?: number;
  /**
   * What `scripting.executeScript({func, args})` resolves its `result` to —
   * the extracted payload the injected `__btExtract` would return. The
   * `files`-only define step always resolves `{result: undefined}`. A function
   * receives the injection args so a test can vary by mode.
   */
  scriptResult?: unknown | ((mode?: string) => unknown);
  /** data URL `tabs.captureVisibleTab` resolves to. Default a 3-byte jpeg. */
  captureDataUrl?: string;
  /**
   * Seed for `chrome.bookmarks` (chrome profile only).
   *
   * A FLAT list with `parentId`; the fake reassembles the tree, because the
   * code under test walks `children` and a fixture that hand-nests would let a
   * broken `flatten()` pass by accident.
   */
  bookmarkNodes?: Array<{
    id: string;
    parentId?: string;
    title?: string;
    url?: string;
    index?: number;
    dateAdded?: number;
  }>;
  /** HistoryItems `history.search` returns (chrome profile only). Default []. */
  historyItems?: Array<{
    url: string;
    title?: string;
    lastVisitTime?: number;
    visitCount?: number;
  }>;
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
  const profile = config.profile ?? "chrome";
  const isSafari = profile === "safari";
  const withAlarms = config.withAlarms ?? true;
  let windows: ChromeWindowLike[] = config.windows ?? [];
  const groups: ChromeTabGroupLike[] = config.groups ?? [];
  let nextWindowId = 900;
  /** How many `windows.update({state})` calls are accepted and then reverted. */
  let stateClobbersLeft = config.stateClobbers ?? 0;

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

  const flatTabs = (): unknown[] => windows.flatMap((w) => w.tabs ?? []);

  /** Accumulated `windows.update` payloads, so `windows.get` reads them back. */
  const windowPatches = new Map<number, Record<string, unknown>>();

  /**
   * Accumulated relocations from `tabs.move` / `windows.create({tabId})`, so
   * `tabs.get` reads POST-move state the way real Chrome does. Exists because
   * move_tab now finishes with a final `tabs.get` to report where the tab
   * actually ended up — a fake whose reads ignored its own writes would fail
   * exactly the honest implementation.
   */
  const tabPatches = new Map<number, Record<string, unknown>>();
  const tabById = (tabId: number): Record<string, unknown> | undefined => {
    const seeded = flatTabs().find((t) => (t as { id?: number }).id === tabId);
    if (!seeded && !tabPatches.has(tabId)) return undefined;
    return {
      ...((seeded as object | undefined) ?? { id: tabId }),
      ...(tabPatches.get(tabId) ?? {}),
    };
  };

  /**
   * A window as `windows.get` sees it, lowest precedence first:
   * defaults (with `initialWindowState`) < the seeded window < recorded updates.
   */
  const windowById = (windowId: number): Record<string, unknown> => ({
    id: windowId,
    focused: false,
    incognito: false,
    state: config.initialWindowState ?? "normal",
    ...(windows.find((w) => w.id === windowId) ?? {}),
    ...(windowPatches.get(windowId) ?? {}),
  });

  const tabs: Record<string, unknown> = {
    query: (queryInfo?: unknown) => {
      record("tabs.query", [queryInfo]);
      return Promise.resolve(flatTabs());
    },
    // Modelled, not stubbed: resolves the SEEDED tab, and rejects with
    // Chrome's exact wording for an unknown id — the per-id validation in
    // group commands and the daemon's error translation both key off that
    // message, so a softer fake would let both rot.
    get: (tabId: number) => {
      record("tabs.get", [tabId]);
      const tab = tabById(tabId);
      if (!tab) return Promise.reject(new Error(`No tab with id: ${tabId}.`));
      return Promise.resolve(tab);
    },
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
      tabPatches.set(tabId, {
        ...(tabPatches.get(tabId) ?? {}),
        ...(moveProps.windowId !== undefined ? { windowId: moveProps.windowId } : {}),
        // -1 means "append; the browser assigns the real index" — model that
        // by NOT patching, so a follow-up tabs.get returns the seeded index
        // rather than echoing the sentinel (which is the real-Chrome bug the
        // final read exists to paper over).
        ...(moveProps.index !== undefined && moveProps.index !== -1
          ? { index: moveProps.index }
          : {}),
      });
      // Deliberately echoes the REQUESTED index, sentinel and all — real
      // Chrome has returned worse (indices past the end of the window).
      return Promise.resolve({ id: tabId, windowId: moveProps.windowId, index: moveProps.index });
    },
    // Resolves the SEEDED tab when there is one, so callers that read
    // `windowId` off the result (focus_tab) land on the window the tab is
    // actually in rather than a constant. Falls back to the constant when the
    // test seeded no windows.
    update: (tabId: number, props?: unknown) => {
      record("tabs.update", [tabId, props]);
      const seeded = flatTabs().find((t) => (t as { id?: number }).id === tabId);
      return Promise.resolve({
        ...((seeded as object | undefined) ?? {}),
        id: tabId,
        windowId: (seeded as { windowId?: number } | undefined)?.windowId ?? DEFAULT_WINDOW_ID,
      });
    },
    remove: (tabId: number) => {
      record("tabs.remove", [tabId]);
      return Promise.resolve();
    },
    reload: (tabId?: number, props?: unknown) => {
      record("tabs.reload", [tabId, props]);
      return Promise.resolve();
    },
    goBack: (tabId?: number) => {
      record("tabs.goBack", [tabId]);
      return Promise.resolve();
    },
    goForward: (tabId?: number) => {
      record("tabs.goForward", [tabId]);
      return Promise.resolve();
    },
    duplicate: (tabId: number) => {
      record("tabs.duplicate", [tabId]);
      return Promise.resolve({ id: tabId + 1, windowId: DEFAULT_WINDOW_ID });
    },
    captureVisibleTab: (windowId?: number, opts?: unknown) => {
      record("tabs.captureVisibleTab", [windowId, opts]);
      return Promise.resolve(config.captureDataUrl ?? "data:image/jpeg;base64,/9j/AA==");
    },
    ...Object.fromEntries(tabsEvents.map((name) => [name, makeEvent(`tabs.${name}`)])),
  };
  // Safari lacks tabs.discard/group/ungroup (and tab groups entirely).
  if (!isSafari) {
    tabs.discard = (tabId?: number) => {
      record("tabs.discard", [tabId]);
      return Promise.resolve({ id: tabId, discarded: true });
    };
    tabs.group = (options: { tabIds: number | number[]; groupId?: number }) => {
      record("tabs.group", [options]);
      return Promise.resolve(options.groupId ?? 700);
    };
    tabs.ungroup = (tabIds: number | number[]) => {
      record("tabs.ungroup", [tabIds]);
      return Promise.resolve();
    };
  }

  const fake: Record<string, unknown> = {
    windows: {
      getAll: (query?: unknown) => {
        record("windows.getAll", [query]);
        return Promise.resolve(windows);
      },
      create: (createData?: { tabId?: number; url?: string | string[] }) => {
        record("windows.create", [createData]);
        const urls = Array.isArray(createData?.url)
          ? createData.url
          : createData?.url
            ? [createData.url]
            : [];
        const tabs = urls.map((u, i) => ({ id: 8000 + i, url: u, index: i, active: i === 0 }));
        const id = nextWindowId++;
        // Adopting a tab relocates it — tabs.get must see the NEW home.
        if (createData?.tabId !== undefined) {
          tabPatches.set(createData.tabId, {
            ...(tabPatches.get(createData.tabId) ?? {}),
            windowId: id,
            index: 0,
          });
        }
        return Promise.resolve({ id, tabs });
      },
      // Both `update` and `get` are modelled, not stubbed. `update` merges the
      // requested change into a per-window overlay that `get` reads back, so a
      // caller that reads its own write (focus_tab reporting the window's
      // post-state) is testable at all — and the `stateClobbers` knob layers the
      // real Chrome failure on top of that same overlay.
      update: (windowId: number, info?: unknown) => {
        record("windows.update", [windowId, info]);
        const patch = {
          ...(windowPatches.get(windowId) ?? {}),
          ...((info ?? {}) as object),
        } as Record<string, unknown>;
        const next = (info as { state?: string } | undefined)?.state;
        if (next !== undefined && stateClobbersLeft > 0) {
          // Model the real clobber: a geometry update lands asynchronously and
          // re-asserts the old state, so the first N state updates paired with
          // one appear to be accepted and then silently revert.
          stateClobbersLeft -= 1;
          delete patch.state;
        }
        windowPatches.set(windowId, patch);
        return Promise.resolve({ ...windowById(windowId), id: windowId });
      },
      get: (windowId: number, queryOptions?: unknown) => {
        record("windows.get", [windowId, queryOptions]);
        return Promise.resolve(windowById(windowId));
      },
      remove: (windowId: number) => {
        record("windows.remove", [windowId]);
        return Promise.resolve();
      },
      onCreated: makeEvent("windows.onCreated"),
      onRemoved: makeEvent("windows.onRemoved"),
      onFocusChanged: makeEvent("windows.onFocusChanged"),
    },
    tabs,
    scripting: {
      executeScript: (injection?: unknown) => {
        record("scripting.executeScript", [injection]);
        const inj = injection as { func?: unknown; args?: unknown[] } | undefined;
        // The define step (files only) resolves empty; the call step (func +
        // args) resolves the configured extraction payload.
        if (!inj?.func) return Promise.resolve([{ result: undefined }]);
        const mode = (inj.args?.[0] as string | undefined) ?? undefined;
        const value =
          typeof config.scriptResult === "function"
            ? (config.scriptResult as (m?: string) => unknown)(mode)
            : config.scriptResult;
        return Promise.resolve([{ result: value }]);
      },
    },
    webNavigation: {
      onCommitted: makeEvent("webNavigation.onCommitted"),
      onBeforeNavigate: makeEvent("webNavigation.onBeforeNavigate"),
    },
    runtime: {
      getManifest: () => ({ version: config.version ?? "0.0.0-test", manifest_version: 3 }),
      getURL: (path: string) => `chrome-extension://fake/${path}`,
      openOptionsPage: () => {
        record("runtime.openOptionsPage", []);
        return Promise.resolve();
      },
      /**
       * Present in Chrome 25+ AND Safari 14+ — the only extension-restart
       * mechanism that exists in both, which is why `reload_extension` uses it
       * rather than a `chrome.management` disable/enable dance (Safari has no
       * `chrome.management` at all). Recorded, never actually reloading.
       */
      reload: () => {
        record("runtime.reload", []);
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

  // Chrome-family only: tab groups + history APIs (Safari has neither).
  if (!isSafari) {
    fake.tabGroups = {
      query: (queryInfo?: unknown) => {
        record("tabGroups.query", [queryInfo]);
        return Promise.resolve(groups);
      },
      update: (groupId: number, props?: unknown) => {
        record("tabGroups.update", [groupId, props]);
        return Promise.resolve({ id: groupId });
      },
      move: (groupId: number, props?: unknown) => {
        record("tabGroups.move", [groupId, props]);
        return Promise.resolve({ id: groupId });
      },
      onCreated: makeEvent("tabGroups.onCreated"),
      onUpdated: makeEvent("tabGroups.onUpdated"),
      onMoved: makeEvent("tabGroups.onMoved"),
      onRemoved: makeEvent("tabGroups.onRemoved"),
    };
    // Bookmarks: a mutable store so create/update/remove are observable, and a
    // tree assembled from the flat seed on every read — the code under test
    // walks `children`, so building the nesting HERE is what makes its
    // flatten() genuinely exercised.
    const bmStore = new Map<string, Record<string, unknown>>();
    for (const n of config.bookmarkNodes ?? []) bmStore.set(n.id, { ...n, title: n.title ?? "" });
    let bmNextId = 1000;
    const bmChildren = (parentId: string | undefined): Record<string, unknown>[] =>
      [...bmStore.values()].filter((n) => n.parentId === parentId);
    const bmTree = (node: Record<string, unknown>): Record<string, unknown> => ({
      ...node,
      ...(node.url === undefined ? { children: bmChildren(node.id as string).map(bmTree) } : {}),
    });
    fake.bookmarks = {
      search: (query?: unknown) => {
        record("bookmarks.search", [query]);
        const q = String(query ?? "").toLowerCase();
        return Promise.resolve(
          [...bmStore.values()].filter(
            (n) =>
              String(n.title ?? "")
                .toLowerCase()
                .includes(q) ||
              String(n.url ?? "")
                .toLowerCase()
                .includes(q),
          ),
        );
      },
      getTree: () => {
        record("bookmarks.getTree", []);
        // Real Chrome returns a single synthetic root whose children are the
        // bars; modelling that shape is what makes the `flatMap(children)` in
        // the command correct rather than accidentally right.
        return Promise.resolve([
          { id: "0", title: "", children: bmChildren(undefined).map(bmTree) },
        ]);
      },
      getSubTree: (id?: unknown) => {
        record("bookmarks.getSubTree", [id]);
        const node = bmStore.get(String(id));
        return Promise.resolve(node ? [bmTree(node)] : []);
      },
      get: (id?: unknown) => {
        record("bookmarks.get", [id]);
        const node = bmStore.get(String(id));
        return Promise.resolve(node ? [node] : []);
      },
      create: (details?: unknown) => {
        record("bookmarks.create", [details]);
        const d = (details ?? {}) as Record<string, unknown>;
        const id = String(bmNextId++);
        const node: Record<string, unknown> = {
          id,
          ...(d.parentId !== undefined ? { parentId: String(d.parentId) } : {}),
          title: String(d.title ?? ""),
          ...(d.url !== undefined ? { url: String(d.url) } : {}),
        };
        bmStore.set(id, node);
        return Promise.resolve(node);
      },
      update: (id?: unknown, changes?: unknown) => {
        record("bookmarks.update", [id, changes]);
        const node = bmStore.get(String(id));
        if (!node) return Promise.reject(new Error("Can't find bookmark for id."));
        Object.assign(node, changes ?? {});
        return Promise.resolve(node);
      },
      remove: (id?: unknown) => {
        record("bookmarks.remove", [id]);
        const node = bmStore.get(String(id));
        // Real Chrome throws here for a non-empty folder — the command probes
        // and calls removeTree instead, and this is what proves it does.
        if (node && node.url === undefined && bmChildren(String(id)).length > 0) {
          return Promise.reject(
            new Error("Can't remove non-empty folder (use recursive to force)"),
          );
        }
        bmStore.delete(String(id));
        return Promise.resolve();
      },
      removeTree: (id?: unknown) => {
        record("bookmarks.removeTree", [id]);
        const drop = (nid: string): void => {
          for (const c of bmChildren(nid)) drop(c.id as string);
          bmStore.delete(nid);
        };
        drop(String(id));
        return Promise.resolve();
      },
    };
    fake.history = {
      search: (query?: unknown) => {
        record("history.search", [query]);
        return Promise.resolve(config.historyItems ?? []);
      },
      getVisits: (details?: unknown) => {
        record("history.getVisits", [details]);
        return Promise.resolve([]);
      },
    };
  }

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
