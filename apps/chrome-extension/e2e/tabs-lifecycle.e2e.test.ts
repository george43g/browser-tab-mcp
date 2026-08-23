/**
 * Tab lifecycle against a real browser: open → list → focus → close.
 *
 * WHAT MAKES THESE DIFFERENT FROM THE EXISTING TESTS. Every assertion is made
 * TWICE — once against the daemon's snapshot and once against the browser's
 * own truth via `chrome.tabs.query` / `chrome.windows.get` in the extension's
 * service worker. A snapshot agreeing with itself is what a fake adapter
 * already proves; the question this tier exists to answer is whether the
 * browser did the thing.
 *
 * `close_tab` is the reason to start here: it is the weakest surface in the
 * registry — one extension-core unit test against a fake `tabs.remove`, and
 * nothing at all covering the tool handler, the client function, the daemon
 * routing, or the CLI's arg glue.
 */

import { EXPECTED_BROWSER, expect, type Stack, startStack, test } from "./fixtures.js";
import { type LocalServer, PAGE_MARKER, startLocalServer } from "./local-server.js";

test.describe.configure({ mode: "serial" });

interface RawTab {
  id: number;
  url: string;
  windowId: number;
  active: boolean;
  index: number;
}

test.describe("tab lifecycle", () => {
  let stack: Stack;
  let server: LocalServer;

  /** Every tab the browser currently has — the browser's own account, not ours. */
  const realTabs = (): Promise<RawTab[]> =>
    stack.sw.evaluate(async () => {
      const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      const tabs = await c.tabs.query({});
      return tabs.map((t) => ({
        id: t.id as number,
        url: t.url ?? "",
        windowId: t.windowId,
        active: t.active,
        index: t.index,
      }));
    });

  /** Every tab handle the daemon's snapshot is currently serving. */
  const snapshotTabIds = async (): Promise<string[]> => {
    const chrome = await stack.browserState();
    const windows = (chrome?.windows ?? []) as Array<Record<string, unknown>>;
    return windows.flatMap((w) =>
      ((w.tabs ?? []) as Array<Record<string, unknown>>).map((t) => String(t.tabId)),
    );
  };

  test.beforeAll(async () => {
    stack = await startStack(import.meta.url);
    server = await startLocalServer();
  });

  test.afterAll(async () => {
    await server?.close();
    await stack?.close();
  });

  test("open_tab creates a tab the BROWSER has, not just the snapshot", async () => {
    test.info().annotations.push({ type: "surface", description: "open_tab" });
    const url = server.url("/u/opened");

    // `--browser` EXPLICITLY, and this is not incidental. An untargeted
    // `open_tab` resolves to `enabledBrowsers()[0]`
    // (`client/tabs-service.ts:150`) — chrome by default, whatever is actually
    // running. On the msedge leg that routed to the FAKE AppleScript adapter
    // and returned `t:chrome:9999` instead of an x-handle (CI, 2026-08-24).
    // The default is deterministic by design, so this is not a bug being
    // hidden; it is simply not observable on this tier, because the fake
    // adapter fabricates a running chrome for every run. See BACKLOG B12.
    const raw = JSON.parse(
      await stack.daemon.cli(["open", url, "--browser", EXPECTED_BROWSER, "--json"]),
    ) as {
      ok: boolean;
      command: string;
      tabId?: string;
    };
    expect(raw.ok).toBe(true);
    expect(raw.command).toBe("open_tab");
    expect(raw.tabId, "result must carry an extension-generation handle").toMatch(
      /^t:(chrome|edge):x\d+$/,
    );

    // Browser truth. `tabs.query` is the account that cannot be faked by a
    // snapshot the daemon built from its own optimism.
    await expect
      .poll(async () => (await realTabs()).some((t) => t.url === url), { timeout: 10_000 })
      .toBe(true);
    const tab = (await realTabs()).find((t) => t.url === url) as RawTab;
    expect(raw.tabId).toBe(stack.tabHandle(tab.id));

    // …and the daemon is serving the same tab under the same handle.
    await expect
      .poll(async () => (await snapshotTabIds()).includes(stack.tabHandle(tab.id)), {
        timeout: 10_000,
        intervals: [250],
      })
      .toBe(true);
  });

  test("open_tab --no-activate leaves the window's active tab alone", async () => {
    test.info().annotations.push({ type: "surface", description: "open_tab:no-activate" });
    const before = await realTabs();
    const activeBefore = before.find((t) => t.active) as RawTab;
    expect(activeBefore, "a window must have an active tab to begin with").toBeTruthy();

    const url = server.url("/u/background");
    const raw = JSON.parse(
      await stack.daemon.cli([
        "open",
        url,
        "--window",
        stack.windowHandle(activeBefore.windowId),
        "--no-activate",
        "--json",
      ]),
    ) as { ok: boolean; tabId?: string };
    expect(raw.ok).toBe(true);

    await expect
      .poll(async () => (await realTabs()).some((t) => t.url === url), { timeout: 10_000 })
      .toBe(true);
    const after = await realTabs();
    const created = after.find((t) => t.url === url) as RawTab;
    expect(created.windowId, "must land in the window we asked for").toBe(activeBefore.windowId);
    expect(created.active, "background open must NOT steal activation").toBe(false);
    expect(
      after.find((t) => t.windowId === activeBefore.windowId && t.active)?.id,
      "the previously active tab must still be the active one",
    ).toBe(activeBefore.id);
  });

  test("list_tabs projections agree with the browser's own tab count", async () => {
    test.info().annotations.push({ type: "surface", description: "list_tabs" });

    // `summary` returns windows + counts and ZERO tab rows — still a valid
    // Snapshot. The COUNT is the assertion: a projection that dropped the
    // count too would be indistinguishable from an empty browser.
    //
    // Poll both sides together rather than reading each once: the snapshot is
    // pushed on the extension's event, so a read taken between the browser
    // creating a tab and the push landing legitimately disagrees.
    const counts = async (): Promise<{ real: number; summary: number }> => {
      const real = (await realTabs()).length;
      const sum = await stack.browserState(["--fields", "summary"]);
      const windows = (sum?.windows ?? []) as Array<Record<string, unknown>>;
      expect(
        windows.every((w) => ((w.tabs ?? []) as unknown[]).length === 0),
        "summary must carry zero tab rows",
      ).toBe(true);
      return { real, summary: windows.reduce((a, w) => a + Number(w.tabCount ?? 0), 0) };
    };
    await expect
      .poll(async () => JSON.stringify(await counts()), { timeout: 10_000, intervals: [250] })
      .toMatch(/^\{"real":(\d+),"summary":\1\}$/);

    // `--url` drops non-matching windows entirely.
    const filtered = await stack.browserState(["--url", "/u/opened"]);
    const hits = ((filtered?.windows ?? []) as Array<Record<string, unknown>>).flatMap(
      (w) => (w.tabs ?? []) as Array<Record<string, unknown>>,
    );
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((t) => String(t.url).includes("/u/opened"))).toBe(true);
    expect(hits.length).toBe((await realTabs()).filter((t) => t.url.includes("/u/opened")).length);
  });

  test("focus_tab activates the tab and raises its window", async () => {
    test.info().annotations.push({ type: "surface", description: "focus_tab" });
    // Two windows, so "raised" means something: the target starts non-focused.
    const ids = await stack.sw.evaluate(async (url) => {
      const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      const target = await c.windows.create({ url, focused: true });
      const other = await c.windows.create({ url: "about:blank", focused: true });
      return {
        targetTabId: target.tabs?.[0]?.id as number,
        targetWinId: target.id as number,
        otherWinId: other.id as number,
      };
    }, server.url("/u/focus-target"));

    const result = JSON.parse(
      await stack.daemon.cli(["focus", stack.tabHandle(ids.targetTabId), "--json"]),
    ) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.windowFocused, "raiseWindow defaults to true").toBe(true);

    // Browser truth: the tab is its window's active tab, and the window is
    // the focused one.
    const state = await stack.sw.evaluate(async (i) => {
      const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      const tab = await c.tabs.get(i.targetTabId);
      const win = await c.windows.get(i.targetWinId);
      return { active: tab.active, focused: win.focused, state: win.state };
    }, ids);
    expect(state.active, "focus_tab must activate the tab in its window").toBe(true);
    expect(state.focused, "focus_tab must raise the window (raiseWindow default)").toBe(true);
    expect(result.windowState).toBe(state.state);
  });

  test("focus_tab un-minimizes the window it raises", async () => {
    test.info().annotations.push({ type: "surface", description: "focus_tab:minimized" });
    // The extension-path analogue of the AppleScript ordering fix (clear
    // `minimized` BEFORE `set index to 1`, because raising a minimized window
    // is a no-op). `wasMinimized` is a BEFORE-state that no later snapshot can
    // recover, so only the acting pathway can report it — which is exactly why
    // it needs a real minimized window to be worth anything.
    const ids = await stack.sw.evaluate(async (url) => {
      const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      const target = await c.windows.create({ url, focused: true });
      await c.windows.create({ url: "about:blank", focused: true });
      await c.windows.update(target.id as number, { state: "minimized" });
      const after = await c.windows.get(target.id as number);
      return {
        targetTabId: target.tabs?.[0]?.id as number,
        targetWinId: target.id as number,
        reallyMinimized: after.state === "minimized",
      };
    }, server.url("/u/minimized"));

    // Measured 2026-08-24 on macOS Chromium: `--headless=new` DOES honour
    // state:"minimized". If a channel or a future build stops honouring it the
    // precondition is unmet and this assertion is untestable here — say so and
    // leave it to the macos-local tier, rather than quietly asserting less.
    test.skip(
      !ids.reallyMinimized,
      "this browser does not honour windows.update({state:'minimized'}) under " +
        "--headless=new, so there is no minimized window to un-minimize. The " +
        "AppleScript half of this behaviour is macos-local either way.",
    );

    const result = JSON.parse(
      await stack.daemon.cli(["focus", stack.tabHandle(ids.targetTabId), "--json"]),
    ) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.wasMinimized, "the acting pathway owns this BEFORE-state").toBe(true);
    expect(result.windowState).toBe("normal");
    expect(result.windowFocused).toBe(true);

    const win = await stack.sw.evaluate(
      async (id) =>
        (await (globalThis as unknown as { chrome: typeof chrome }).chrome.windows.get(id)).state,
      ids.targetWinId,
    );
    expect(win, "browser truth: the window really is out of the dock").toBe("normal");
  });

  test("focus_tab --no-raise activates without touching the window", async () => {
    test.info().annotations.push({ type: "surface", description: "focus_tab:no-raise" });
    const ids = await stack.sw.evaluate(async (url) => {
      const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      const target = await c.windows.create({ url, focused: true });
      // Create the second window LAST and focused, so `target` is demonstrably
      // not frontmost when the command runs.
      const other = await c.windows.create({ url: "about:blank", focused: true });
      const t = target.tabs?.[0]?.id as number;
      // Activate a different tab in the target window, so "activates the tab"
      // is an observable change rather than a no-op.
      await c.tabs.create({ windowId: target.id as number, url: "about:blank", active: true });
      return { targetTabId: t, targetWinId: target.id as number, otherWinId: other.id as number };
    }, server.url("/u/no-raise"));

    const result = JSON.parse(
      await stack.daemon.cli(["focus", stack.tabHandle(ids.targetTabId), "--no-raise", "--json"]),
    ) as Record<string, unknown>;
    expect(result.ok).toBe(true);

    const state = await stack.sw.evaluate(async (i) => {
      const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      const tab = await c.tabs.get(i.targetTabId);
      const other = await c.windows.get(i.otherWinId);
      return { active: tab.active, otherFocused: other.focused };
    }, ids);
    expect(state.active, "--no-raise still activates the tab").toBe(true);
    expect(
      state.otherFocused,
      "--no-raise must leave window focus exactly where it was — this is the whole " +
        "difference between the two pathways",
    ).toBe(true);
  });

  test("close_tab removes the tab from the BROWSER", async () => {
    test.info().annotations.push({ type: "surface", description: "close_tab" });
    const url = server.url("/u/doomed");
    const created = await stack.sw.evaluate(
      async (u) =>
        (await (globalThis as unknown as { chrome: typeof chrome }).chrome.tabs.create({ url: u }))
          .id as number,
      url,
    );
    expect((await realTabs()).some((t) => t.id === created)).toBe(true);

    const raw = JSON.parse(
      await stack.daemon.cli(["close", stack.tabHandle(created), "--json"]),
    ) as { ok: boolean; command: string };
    expect(raw.ok).toBe(true);
    expect(raw.command).toBe("close_tab");

    // The assertion that matters: gone from chrome.tabs.query, not merely
    // absent from a snapshot the daemon rebuilt after being told it worked.
    await expect
      .poll(async () => (await realTabs()).some((t) => t.id === created), { timeout: 10_000 })
      .toBe(false);
    await expect
      .poll(async () => (await snapshotTabIds()).includes(stack.tabHandle(created)), {
        timeout: 10_000,
        intervals: [250],
      })
      .toBe(false);
  });

  test("a page served by the local origin really is reachable (fixture canary)", async () => {
    // If the server were serving 404s or nothing, every assertion above would
    // still pass — tabs exist regardless of what loads in them. This is the
    // canary that the fixture is a fixture.
    const page = await stack.context.newPage();
    await page.goto(server.url("/a"));
    await expect(page.locator("body")).toContainText(PAGE_MARKER);
    await page.close();
  });
});
