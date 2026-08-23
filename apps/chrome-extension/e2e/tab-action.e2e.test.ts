/**
 * `tab_action` against a real browser: mute/unmute, pin/unpin, reload,
 * duplicate, navigate.
 *
 * These are the actions whose only coverage today is
 * `packages/extension-core/src/commands.test.ts` against a fake `chrome.tabs`
 * that returns whatever it was handed. That proves the command was SHAPED
 * correctly. It cannot prove the tab was muted, because nothing was ever muted.
 *
 * Every case reads its outcome back through `chrome.tabs.get` — the browser's
 * own record of the tab — and, where the snapshot is supposed to carry the
 * enrichment (audible/muted, pinned), through the daemon too. The enrichment
 * pass-through is a documented contract invariant (`TabEnrichmentSchema`), and
 * a field that silently stops being copied looks identical to a browser that
 * ignored the command.
 *
 * back/forward and discard live in their OWN files. Both destroy state this
 * file depends on — see their headers.
 */

import { EXPECTED_BROWSER, expect, type Stack, startStack, test } from "./fixtures.js";
import { type LocalServer, startLocalServer } from "./local-server.js";

test.describe.configure({ mode: "serial" });

interface TabFacts {
  id: number;
  url: string;
  mutedInfo: boolean;
  pinned: boolean;
  index: number;
  windowId: number;
}

test.describe("tab_action", () => {
  let stack: Stack;
  let server: LocalServer;

  const facts = (id: number): Promise<TabFacts> =>
    stack.sw.evaluate(async (tabId) => {
      const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      const t = await c.tabs.get(tabId);
      return {
        id: t.id as number,
        url: t.url ?? "",
        mutedInfo: t.mutedInfo?.muted ?? false,
        pinned: t.pinned,
        index: t.index,
        windowId: t.windowId,
      };
    }, id);

  /** The daemon's row for one tab handle, or undefined. */
  const snapshotTab = async (handle: string): Promise<Record<string, unknown> | undefined> => {
    const chrome = await stack.browserState();
    const windows = (chrome?.windows ?? []) as Array<Record<string, unknown>>;
    return windows
      .flatMap((w) => (w.tabs ?? []) as Array<Record<string, unknown>>)
      .find((t) => t.tabId === handle);
  };

  /** A fresh tab at `path`, returned as {id, handle}. */
  const newTab = async (path: string): Promise<{ id: number; handle: string }> => {
    const id = await stack.sw.evaluate(
      async (u) =>
        (await (globalThis as unknown as { chrome: typeof chrome }).chrome.tabs.create({ url: u }))
          .id as number,
      server.url(path),
    );
    return { id, handle: stack.tabHandle(id) };
  };

  const act = async (
    handle: string,
    action: string,
    extra: string[] = [],
  ): Promise<Record<string, unknown>> =>
    JSON.parse(await stack.daemon.cli(["act", handle, action, ...extra, "--json"]));

  test.beforeAll(async () => {
    stack = await startStack(import.meta.url);
    server = await startLocalServer();
  });

  test.afterAll(async () => {
    await server?.close();
    await stack?.close();
  });

  test("mute and unmute change the tab's real mutedInfo", async () => {
    test.info().annotations.push({ type: "surface", description: "tab_action:mute" });
    const { id, handle } = await newTab("/u/mute");
    expect((await facts(id)).mutedInfo, "precondition: a fresh tab is not muted").toBe(false);

    expect((await act(handle, "mute")).ok).toBe(true);
    expect((await facts(id)).mutedInfo, "browser truth: the tab is muted").toBe(true);
    // The snapshot must carry it too — `muted` is a TabEnrichmentSchema
    // pass-through, and a mapper that quietly stops copying it is
    // indistinguishable from a browser that ignored the command.
    await expect
      .poll(async () => (await snapshotTab(handle))?.muted, { timeout: 10_000, intervals: [250] })
      .toBe(true);

    expect((await act(handle, "unmute")).ok).toBe(true);
    expect((await facts(id)).mutedInfo).toBe(false);
    await expect
      .poll(async () => (await snapshotTab(handle))?.muted, { timeout: 10_000, intervals: [250] })
      .toBe(false);
  });

  test("pin moves the tab to the front of its window, and unpin releases it", async () => {
    test.info().annotations.push({ type: "surface", description: "tab_action:pin" });
    // Pinning is not just a flag: Chrome RELOCATES a pinned tab to index 0.
    // Asserting only `pinned:true` would miss a reorder that shuffles every
    // other tab in the window — which is what makes this worth a real browser.
    const first = await newTab("/u/pin-neighbour");
    const { id, handle } = await newTab("/u/pin-target");
    expect((await facts(id)).index, "precondition: target is not already first").toBeGreaterThan(0);
    void first;

    expect((await act(handle, "pin")).ok).toBe(true);
    const pinned = await facts(id);
    expect(pinned.pinned, "browser truth: pinned").toBe(true);
    expect(pinned.index, "Chrome relocates a pinned tab to the front").toBe(0);
    await expect
      .poll(async () => (await snapshotTab(handle))?.pinned, { timeout: 10_000, intervals: [250] })
      .toBe(true);

    expect((await act(handle, "unpin")).ok).toBe(true);
    expect((await facts(id)).pinned).toBe(false);
  });

  test("navigate takes the tab to the URL, in place", async () => {
    test.info().annotations.push({ type: "surface", description: "tab_action:navigate" });
    const { id, handle } = await newTab("/a");
    const before = await facts(id);

    const dest = server.url("/b");
    expect((await act(handle, "navigate", ["--url", dest])).ok).toBe(true);

    await expect.poll(async () => (await facts(id)).url, { timeout: 10_000 }).toBe(dest);
    const after = await facts(id);
    expect(after.id, "navigate must reuse the tab, not open a new one").toBe(before.id);
    expect(after.windowId).toBe(before.windowId);
  });

  test("navigate without --url is refused", async () => {
    test.info().annotations.push({ type: "surface", description: "tab_action:navigate-no-url" });
    const { handle } = await newTab("/a");
    await expect(stack.daemon.cli(["act", handle, "navigate", "--json"])).rejects.toThrow();
  });

  test("reload actually re-fetches the page", async () => {
    test.info().annotations.push({ type: "surface", description: "tab_action:reload" });
    // A reload that did nothing would leave the URL identical, so the URL is
    // no evidence at all. Mutate the live DOM first: only a real re-fetch
    // throws the mutation away. (The fixture serves `cache-control: no-store`
    // so the browser cannot satisfy this from cache without a request.)
    const { id, handle } = await newTab("/u/reload");
    const page = await expect
      .poll(
        () => stack.context.pages().find((p) => p.url() === server.url("/u/reload")) !== undefined,
        { timeout: 10_000 },
      )
      .toBe(true);
    void page;
    const target = stack.context
      .pages()
      .find((p) => p.url() === server.url("/u/reload")) as import("@playwright/test").Page;
    await target.evaluate(() => {
      document.body.setAttribute("data-e2e-survived", "yes");
    });
    expect(await target.evaluate(() => document.body.getAttribute("data-e2e-survived"))).toBe(
      "yes",
    );

    expect((await act(handle, "reload")).ok).toBe(true);

    await expect
      .poll(
        async () =>
          await target
            .evaluate(() => document.body.getAttribute("data-e2e-survived"))
            .catch(() => "pending"),
        { timeout: 10_000, intervals: [250] },
      )
      .toBe(null);
    expect((await facts(id)).url, "reload must not navigate anywhere").toBe(
      server.url("/u/reload"),
    );
  });

  test("duplicate creates a SECOND tab at the same URL", async () => {
    test.info().annotations.push({ type: "surface", description: "tab_action:duplicate" });
    const { id, handle } = await newTab("/u/dup");
    const url = server.url("/u/dup");

    const result = await act(handle, "duplicate");
    expect(result.ok).toBe(true);
    expect(result.tabId, "the result names the NEW tab, not the original").toMatch(
      new RegExp(`^t:${EXPECTED_BROWSER}:x\\d+$`),
    );
    expect(result.tabId).not.toBe(handle);

    const copies = await stack.sw.evaluate(
      async (u) =>
        (await (globalThis as unknown as { chrome: typeof chrome }).chrome.tabs.query({})).filter(
          (t) => t.url === u,
        ).length,
      url,
    );
    expect(copies, "browser truth: two tabs now hold this URL").toBe(2);
    expect((await facts(id)).url, "the original is untouched").toBe(url);
  });

  test("an unknown action is refused rather than silently ignored", async () => {
    test.info().annotations.push({ type: "surface", description: "tab_action:unknown" });
    const { handle } = await newTab("/a");
    await expect(stack.daemon.cli(["act", handle, "levitate", "--json"])).rejects.toThrow();
  });
});
