/**
 * The three read surfaces that record what a browser DID: `journal`,
 * `history`, `bookmarks`.
 *
 * Each has the same structural gap today. `journal.integration.test.ts` feeds
 * synthetic `tabs.onActivated` / `webNavigation.onCommitted` events into a
 * fake chrome; `history.integration.test.ts` stubs `chrome.history.search`;
 * `bookmarks.integration.test.ts` stubs `chrome.bookmarks`. All three prove
 * the daemon's handling of an event or a row it was HANDED. None can prove
 * the browser emits or records anything, because in those tests it never does.
 *
 * Here the events are real: a real focus change, a real committed navigation,
 * a real visit landing in the real history database, a real bookmark tree.
 */

import { EXPECTED_BROWSER, expect, type Stack, startStack, test } from "./fixtures.js";
import { type LocalServer, startLocalServer } from "./local-server.js";

test.describe.configure({ mode: "serial" });

test.describe("journal / history / bookmarks", () => {
  let stack: Stack;
  let server: LocalServer;

  test.beforeAll(async () => {
    stack = await startStack(import.meta.url);
    server = await startLocalServer();
  });

  test.afterAll(async () => {
    await server?.close();
    await stack?.close();
  });

  test("journal records a REAL committed navigation", async () => {
    test.info().annotations.push({ type: "surface", description: "journal" });
    const url = server.url("/u/journalled");
    const id = await stack.sw.evaluate(async (u) => {
      const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      const w = await c.windows.create({ url: u, focused: true });
      return w.tabs?.[0]?.id as number;
    }, url);
    await stack.waitForTab(stack.tabHandle(id));

    // NAV RECORDS LIVE IN `journey`, NOT `recent`. `recent`/`windowMru`/
    // `tabMru` are FOCUS views and return `nav: []` unconditionally
    // (`daemon/journal.ts`); only `journey` returns navigation. That is by
    // design and is pinned below, because a first draft of this test polled
    // `recent` for the URL and would have waited forever.
    await expect
      .poll(
        async () =>
          await stack.daemon.cli([
            "journal",
            "--view",
            "journey",
            "--tab",
            stack.tabHandle(id),
            "--json",
          ]),
        { timeout: 20_000, intervals: [500] },
      )
      .toContain(url);

    const journey = JSON.parse(
      await stack.daemon.cli([
        "journal",
        "--view",
        "journey",
        "--tab",
        stack.tabHandle(id),
        "--json",
      ]),
    ) as { nav: Array<Record<string, unknown>> };
    const record = journey.nav.find((r) => r.url === url) as Record<string, unknown>;
    expect(record, "the committed navigation is recorded").toBeTruthy();
    expect(record.source, "sourced from the extension, not derived from a poll diff").toBe("ext");
    expect(
      record.transition,
      "the browser's own transitionType survives the trip — a poll-derived record has none",
    ).toBe("link");
    expect(
      Number(record.navEpoch),
      "navEpoch is the cache-busting key the content and screenshot caches rely on",
    ).toBeGreaterThan(0);

    // …and the focus views really are focus-only, so nobody "fixes" the
    // empty `nav` above into an inconsistency.
    const recent = JSON.parse(
      await stack.daemon.cli(["journal", "--view", "recent", "--limit", "20", "--json"]),
    ) as { focus: Array<Record<string, unknown>>; nav: unknown[] };
    expect(recent.nav, "recent is a FOCUS view by design").toEqual([]);
    expect(
      recent.focus.some(
        (r) =>
          r.windowId ===
            stack.windowHandle(Number(stack.tabHandle(id).replace(/^t:[a-z]+:x/, "")) && 0) ||
          r.kind === "window-focus",
      ),
      "but it did record real focus activity",
    ).toBe(true);
  });

  test("journal's windowMru is ordered by real focus events", async () => {
    test.info().annotations.push({ type: "surface", description: "journal:windowMru" });
    // MRU is the daemon's memory of where the user has been. A fake event
    // stream can assert the ORDERING LOGIC but never that the browser emits
    // `onFocusChanged` at all — which is the half that only a real browser
    // can answer.
    //
    // MEASURED 2026-08-24 under `--headless=new`: creating a window with
    // `focused:true` DOES emit onFocusChanged; calling
    // `windows.update(existingId, {focused:true})` emits NOTHING and does not
    // move `getLastFocused()`. So MRU driven by re-focusing an existing
    // window is not observable on this tier — that belongs to macos-local,
    // where a window manager is real. Creation-ordered MRU is observable, and
    // is what this asserts. Do not "fix" this by adding a re-focus step; it
    // will pass or fail on nothing.
    const ids = await stack.sw.evaluate(async (u) => {
      const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      const older = await c.windows.create({ url: u, focused: true });
      const newer = await c.windows.create({ url: "about:blank", focused: true });
      return { older: older.id as number, newer: newer.id as number };
    }, server.url("/u/mru"));

    const mruOrder = async (): Promise<string[]> => {
      const out = JSON.parse(
        await stack.daemon.cli(["journal", "--view", "windowMru", "--json"]),
      ) as { focus: Array<Record<string, unknown>> };
      // The payload is `{view, focus: [...], nav: []}` — MRU is a focus view,
      // so records live under `focus`, not a generic `records` key.
      return out.focus.map((r) => String(r.windowId));
    };

    await expect
      .poll(async () => (await mruOrder())[0] ?? "", { timeout: 20_000, intervals: [500] })
      .toBe(stack.windowHandle(ids.newer));

    // …and the earlier window is still remembered, behind it. An MRU that
    // only ever held one entry would satisfy the assertion above.
    const order = await mruOrder();
    expect(order, "the earlier window is remembered too").toContain(stack.windowHandle(ids.older));
    expect(
      order.indexOf(stack.windowHandle(ids.newer)),
      "most-recently-focused first",
    ).toBeLessThan(order.indexOf(stack.windowHandle(ids.older)));
  });

  test("history finds a URL this run really visited", async () => {
    test.info().annotations.push({ type: "surface", description: "history" });
    const nonce = `e2e-${Date.now()}`;
    const url = server.url(`/u/${nonce}`);
    const id = await stack.sw.evaluate(async (u) => {
      const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      const w = await c.windows.create({ url: u, focused: true });
      return w.tabs?.[0]?.id as number;
    }, url);
    await stack.waitForTab(stack.tabHandle(id));

    await expect
      .poll(
        async () =>
          (
            await stack.daemon.cli([
              "history",
              "--browser",
              EXPECTED_BROWSER,
              "--query",
              nonce,
              "--json",
            ])
          ).includes(nonce),
        { timeout: 20_000, intervals: [500] },
      )
      .toBe(true);
  });

  test("history always reports the sources it considered", async () => {
    test.info().annotations.push({ type: "surface", description: "history:sources" });
    // The contract that exists because a merged query returning Chrome-only
    // rows was otherwise indistinguishable from "Safari had nothing". Every
    // result carries one {browser, source, status} per source CONSIDERED,
    // including the ones it never asked.
    const merged = JSON.parse(
      await stack.daemon.cli(["history", "--query", "definitely-not-present-xyzzy", "--json"]),
    ) as { sources?: Array<Record<string, unknown>> };
    expect(Array.isArray(merged.sources), "`sources` is never omitted").toBe(true);
    expect((merged.sources ?? []).length).toBeGreaterThan(0);
    expect(
      (merged.sources ?? []).some((s) => s.browser === EXPECTED_BROWSER),
      "the live browser must appear among the sources considered",
    ).toBe(true);
  });

  test("bookmarks round-trips through the real chrome.bookmarks tree", async () => {
    test.info().annotations.push({ type: "surface", description: "bookmarks" });
    const bm = (args: string[]): Promise<string> =>
      stack.daemon.cli(["bookmark", ...args, "--browser", EXPECTED_BROWSER, "--json"]);

    const title = `e2e-bookmark-${Date.now()}`;
    const url = server.url("/u/bookmarked");

    // The result shape is `{action, browser, nodes: [...], truncated}` — every
    // bookmarks action answers with a NODE LIST, including create, so a caller
    // never has to special-case one action's reply.
    const created = JSON.parse(await bm(["create", "--title", title, "--url", url])) as {
      action: string;
      nodes: Array<Record<string, unknown>>;
    };
    expect(created.action).toBe("create");
    const node = created.nodes[0] as Record<string, unknown>;
    const id = String(node?.id ?? "");
    expect(id, "create must return the new node's real id").not.toBe("");
    expect(node.title).toBe(title);
    expect(node.url).toBe(url);

    // Browser truth: the node exists in chrome.bookmarks, not just in our reply.
    const real = await stack.sw.evaluate(async (nodeId) => {
      const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      const [n] = await c.bookmarks.get(nodeId);
      return { title: n?.title ?? "", url: n?.url ?? "" };
    }, id);
    expect(real.title).toBe(title);
    expect(real.url).toBe(url);

    // search finds it…
    expect(await bm(["search", "--query", title])).toContain(title);

    // …update renames it in the real tree…
    const renamed = `${title}-renamed`;
    expect(
      (JSON.parse(await bm(["update", "--id", id, "--title", renamed])) as { action: string })
        .action,
    ).toBe("update");
    expect(
      await stack.sw.evaluate(
        async (nodeId) =>
          (
            await (globalThis as unknown as { chrome: typeof chrome }).chrome.bookmarks.get(nodeId)
          )[0]?.title ?? "",
        id,
      ),
    ).toBe(renamed);

    // …and remove really removes it.
    expect((JSON.parse(await bm(["remove", "--id", id])) as { action: string }).action).toBe(
      "remove",
    );
    const gone = await stack.sw.evaluate(async (nodeId) => {
      try {
        await (globalThis as unknown as { chrome: typeof chrome }).chrome.bookmarks.get(nodeId);
        return false;
      } catch {
        return true;
      }
    }, id);
    expect(gone, "remove must delete the node from the browser, not just answer ok").toBe(true);
  });

  test("bookmarks refuses a javascript: URL", async () => {
    test.info().annotations.push({ type: "surface", description: "bookmarks:url-policy" });
    // A bookmarklet is script that runs in whatever page's origin the user
    // clicks it on. The refusal is a security boundary, so it is worth proving
    // against the real command path and not only against a mocked client.
    await expect(
      stack.daemon.cli([
        "bookmark",
        "create",
        "--browser",
        EXPECTED_BROWSER,
        "--title",
        "nope",
        "--url",
        "javascript:alert(1)",
        "--json",
      ]),
    ).rejects.toThrow();
  });
});
