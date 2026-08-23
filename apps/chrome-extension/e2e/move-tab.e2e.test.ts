/**
 * `move_tab`'s pathways beyond the cross-window move.
 *
 * `roundtrip.e2e.test.ts` already proves the crown jewel — a cross-window move
 * that PRESERVES scroll, which is the whole reason the extension exists. What
 * it does not touch is `--new-window` or `--index`, and `--index` carries a
 * measured surprise worth its own test: `tabs.move` ECHOES the requested
 * index, including `-1` for "append", which is not where the tab ends up. The
 * command finishes with a `tabs.get` so the result carries the tab's ACTUAL
 * final position (dogfood 2026-08-20: indices 80-85 reported in a 41-tab
 * window). A fake that echoes its input models the bug, not the fix.
 */

import { EXPECTED_BROWSER, expect, type Stack, startStack, test } from "./fixtures.js";
import { type LocalServer, startLocalServer } from "./local-server.js";

test.describe.configure({ mode: "serial" });

test.describe("move_tab", () => {
  let stack: Stack;
  let server: LocalServer;

  const where = (id: number): Promise<{ windowId: number; index: number }> =>
    stack.sw.evaluate(async (tabId) => {
      const t = await (globalThis as unknown as { chrome: typeof chrome }).chrome.tabs.get(tabId);
      return { windowId: t.windowId, index: t.index };
    }, id);

  test.beforeAll(async () => {
    stack = await startStack(import.meta.url);
    server = await startLocalServer();
  });

  test.afterAll(async () => {
    await server?.close();
    await stack?.close();
  });

  test("--new-window puts the tab in a window that did not exist before", async () => {
    test.info().annotations.push({ type: "surface", description: "move_tab:new-window" });
    const ids = await stack.sw.evaluate(
      async (urls) => {
        const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
        const w = await c.windows.create({ url: urls[0], focused: true });
        const mover = (await c.tabs.create({ windowId: w.id as number, url: urls[1] }))
          .id as number;
        const existing = (await c.windows.getAll({})).map((x) => x.id as number);
        return { home: w.id as number, mover, existing };
      },
      [server.url("/u/m-stay"), server.url("/u/m-move")],
    );

    const result = JSON.parse(
      await stack.daemon.cli(["move", stack.tabHandle(ids.mover), "--new-window", "--json"]),
    ) as { ok: boolean; windowId?: string; index?: number };
    expect(result.ok).toBe(true);
    expect(result.windowId).toMatch(new RegExp(`^w:${EXPECTED_BROWSER}:x\\d+$`));

    const now = await where(ids.mover);
    expect(now.windowId, "the tab left its old window").not.toBe(ids.home);
    expect(
      ids.existing.includes(now.windowId),
      "and landed somewhere that did not exist before the move",
    ).toBe(false);
    expect(result.windowId, "the result names the window the tab is actually in").toBe(
      stack.windowHandle(now.windowId),
    );
    expect(now.index, "sole tab of a fresh window").toBe(0);
  });

  test("--index reports the tab's ACTUAL final position, not tabs.move's echo", async () => {
    test.info().annotations.push({ type: "surface", description: "move_tab:index" });
    // Four tabs in the destination, then move a fifth in with NO --index.
    // "Append" is the omitted form, not `-1`: `targetIndex` is `.min(0)` in
    // the schema, so a negative index is refused at the boundary (asserted
    // below). Internally the append becomes `tabs.move(..., {index: -1})`,
    // and `tabs.move` ECHOES that -1 — the real answer is 4, and only the
    // trailing `tabs.get` produces it.
    const ids = await stack.sw.evaluate(
      async (urls) => {
        const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
        const dest = await c.windows.create({ url: urls[0], focused: true });
        for (let i = 0; i < 3; i++) {
          await c.tabs.create({ windowId: dest.id as number, url: urls[0] });
        }
        const src = await c.windows.create({ url: urls[1], focused: false });
        return { dest: dest.id as number, mover: src.tabs?.[0]?.id as number };
      },
      [server.url("/u/m-filler"), server.url("/u/m-appended")],
    );

    const result = JSON.parse(
      await stack.daemon.cli([
        "move",
        stack.tabHandle(ids.mover),
        "--target-window",
        stack.windowHandle(ids.dest),
        "--json",
      ]),
    ) as { ok: boolean; index?: number; windowId?: string };
    expect(result.ok).toBe(true);

    const actual = await where(ids.mover);
    expect(actual.windowId).toBe(ids.dest);
    expect(actual.index, "appended after the four already there").toBe(4);
    expect(
      result.index,
      "THE ASSERTION: the result must carry the tab's real index, not the -1 " +
        "the append was translated into. tabs.move echoes the request; only " +
        "the trailing tabs.get makes the answer honest. Dogfood 2026-08-20: " +
        "indices 80-85 reported in a 41-tab window.",
    ).toBe(actual.index);
    expect(result.index).not.toBe(-1);
  });

  test("--index places the tab exactly where asked, mid-window", async () => {
    test.info().annotations.push({ type: "surface", description: "move_tab:target-index" });
    const ids = await stack.sw.evaluate(
      async (urls) => {
        const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
        const dest = await c.windows.create({ url: urls[0], focused: true });
        for (let i = 0; i < 3; i++) {
          await c.tabs.create({ windowId: dest.id as number, url: urls[0] });
        }
        const src = await c.windows.create({ url: urls[1], focused: false });
        return { dest: dest.id as number, mover: src.tabs?.[0]?.id as number };
      },
      [server.url("/u/m-filler2"), server.url("/u/m-inserted")],
    );

    const result = JSON.parse(
      await stack.daemon.cli([
        "move",
        stack.tabHandle(ids.mover),
        "--target-window",
        stack.windowHandle(ids.dest),
        "--index",
        "1",
        "--json",
      ]),
    ) as { ok: boolean; index?: number };
    expect(result.ok).toBe(true);

    const actual = await where(ids.mover);
    expect(actual.windowId).toBe(ids.dest);
    expect(actual.index, "inserted at the requested slot, not appended").toBe(1);
    expect(result.index).toBe(1);
  });

  test("a negative --index is refused at the boundary, not passed through", async () => {
    test.info().annotations.push({ type: "surface", description: "move_tab:index-bounds" });
    // `targetIndex` is `.min(0)`. Appending is the OMITTED form — which is
    // why the test above omits it. Passing -1 through would reach
    // `tabs.move` as a valid "append" and make the two spellings silently
    // equivalent, hiding the schema.
    const id = await stack.sw.evaluate(
      async (u) =>
        (await (globalThis as unknown as { chrome: typeof chrome }).chrome.tabs.create({ url: u }))
          .id as number,
      server.url("/u/m-neg"),
    );
    await expect(
      stack.daemon.cli(["move", stack.tabHandle(id), "--index", "-1", "--json"]),
    ).rejects.toThrow();
  });
});
