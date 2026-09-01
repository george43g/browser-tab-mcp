/**
 * `group_tabs` against real `chrome.tabGroups` — including the dogfood bug.
 *
 * THE ONE THAT MATTERS. On 2026-08-20 a `group_tabs create` silently
 * RELOCATED ~40 tabs across windows: omitting `createProperties.windowId`
 * makes Chrome group into the FOCUSED window and drag the tabs there, so a
 * grouping operation became a mass cross-window move. The fix pins the group
 * to the first live tab's OWN window (`extension-core/src/commands.ts`), and
 * it has been proven only against a fake-chrome stub — i.e. against our model
 * of the surprise, not against the surprise.
 *
 * `focusOtherWindowFirst` below is the entire point: create the tabs in window
 * 1, make window 2 frontmost, group, and assert via `chrome.tabs.query` that
 * the tabs are STILL IN WINDOW 1. Against real Chrome, with the fix reverted,
 * that is the bug reproducing.
 *
 * Extension-only by design — there is no AppleScript equivalent — so this tier
 * is the ceiling for this surface, not a stepping stone to another one.
 */

import { EXPECTED_BROWSER, expect, type Stack, startStack, test } from "./fixtures.js";
import { type LocalServer, startLocalServer } from "./local-server.js";

test.describe.configure({ mode: "serial" });

test.describe("group_tabs", () => {
  let stack: Stack;
  let server: LocalServer;

  const groupCli = (args: string[]): Promise<string> =>
    stack.daemon.cli(["group", ...args, "--browser", EXPECTED_BROWSER, "--json"]);

  /** Where every tab actually lives, straight from the browser. */
  const homes = (
    ids: number[],
  ): Promise<Array<{ id: number; windowId: number; groupId: number }>> =>
    stack.sw.evaluate(async (wanted) => {
      const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      const all = await c.tabs.query({});
      return all
        .filter((t) => wanted.includes(t.id as number))
        .map((t) => ({
          id: t.id as number,
          windowId: t.windowId,
          groupId: (t as { groupId?: number }).groupId ?? -1,
        }));
    }, ids);

  test.beforeAll(async () => {
    stack = await startStack(import.meta.url);
    server = await startLocalServer();
  });

  test.afterAll(async () => {
    await server?.close();
    await stack?.close();
  });

  test("create groups tabs in THEIR OWN window, not the focused one", async () => {
    test.info().annotations.push({ type: "surface", description: "group_tabs:create" });

    // Window 1 holds the tabs. Window 2 is created afterwards and focused, so
    // "the focused window" and "the tabs' window" are demonstrably different —
    // which is the precondition the dogfood bug needed.
    const ids = await stack.sw.evaluate(
      async (urls) => {
        const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
        const w1 = await c.windows.create({ url: urls[0], focused: true });
        const a = w1.tabs?.[0]?.id as number;
        const b = (await c.tabs.create({ windowId: w1.id as number, url: urls[1] })).id as number;
        const w2 = await c.windows.create({ url: "about:blank", focused: true });
        return { w1: w1.id as number, w2: w2.id as number, a, b };
      },
      [server.url("/u/g1"), server.url("/u/g2")],
    );

    const focusedBefore = await stack.sw.evaluate(async () => {
      const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      return (await c.windows.getLastFocused()).id as number;
    });
    expect(focusedBefore, "precondition: window 2 is the frontmost one").toBe(ids.w2);

    const handles = [stack.tabHandle(ids.a), stack.tabHandle(ids.b)].join(",");
    const result = JSON.parse(
      await groupCli(["create", "--tabs", handles, "--title", "e2e", "--color", "blue"]),
    ) as { ok: boolean; groupId?: string };
    expect(result.ok).toBe(true);
    expect(result.groupId).toMatch(new RegExp(`^g:${EXPECTED_BROWSER}:x\\d+$`));

    const after = await homes([ids.a, ids.b]);
    expect(after.length, "both tabs still exist").toBe(2);
    for (const t of after) {
      expect(
        t.windowId,
        "THE DOGFOOD BUG: grouping must not relocate tabs into the focused window. " +
          "Omitting createProperties.windowId moved ~40 tabs on 2026-08-20.",
      ).toBe(ids.w1);
      expect(t.groupId, "and they really are grouped").toBeGreaterThan(0);
    }

    // The group's own record, read from chrome.tabGroups rather than inferred.
    const group = await stack.sw.evaluate(async (gid) => {
      const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      const g = await c.tabGroups.get(gid);
      return { title: g.title, color: g.color, windowId: g.windowId };
    }, after[0]?.groupId as number);
    expect(group.title).toBe("e2e");
    expect(group.color).toBe("blue");
    expect(group.windowId, "the group itself lives in window 1 too").toBe(ids.w1);
  });

  test("add, update and remove operate on the real group", async () => {
    test.info().annotations.push({ type: "surface", description: "group_tabs:add" });
    test.info().annotations.push({ type: "surface", description: "group_tabs:update" });
    test.info().annotations.push({ type: "surface", description: "group_tabs:remove" });

    const ids = await stack.sw.evaluate(
      async (urls) => {
        const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
        const w = await c.windows.create({ url: urls[0], focused: true });
        const a = w.tabs?.[0]?.id as number;
        const b = (await c.tabs.create({ windowId: w.id as number, url: urls[1] })).id as number;
        return { w: w.id as number, a, b };
      },
      [server.url("/u/g3"), server.url("/u/g4")],
    );

    const created = JSON.parse(
      await groupCli(["create", "--tabs", stack.tabHandle(ids.a), "--title", "start"]),
    ) as { groupId: string };
    const groupHandle = created.groupId;

    // add
    expect(
      JSON.parse(await groupCli(["add", "--group", groupHandle, "--tabs", stack.tabHandle(ids.b)]))
        .ok,
    ).toBe(true);
    await expect
      .poll(async () => (await homes([ids.b]))[0]?.groupId, { timeout: 10_000 })
      .toBeGreaterThan(0);
    const both = await homes([ids.a, ids.b]);
    expect(both[0]?.groupId, "both tabs share one group").toBe(both[1]?.groupId);

    // update
    expect(
      JSON.parse(
        await groupCli([
          "update",
          "--group",
          groupHandle,
          "--title",
          "renamed",
          "--color",
          "red",
          "--collapsed",
        ]),
      ).ok,
    ).toBe(true);
    const updated = await stack.sw.evaluate(async (gid) => {
      const g = await (globalThis as unknown as { chrome: typeof chrome }).chrome.tabGroups.get(
        gid,
      );
      return { title: g.title, color: g.color, collapsed: g.collapsed };
    }, both[0]?.groupId as number);
    expect(updated).toEqual({ title: "renamed", color: "red", collapsed: true });

    // remove — ungroups the tab; it must survive, not be closed.
    expect(JSON.parse(await groupCli(["remove", "--tabs", stack.tabHandle(ids.b)])).ok).toBe(true);
    await expect.poll(async () => (await homes([ids.b]))[0]?.groupId, { timeout: 10_000 }).toBe(-1);
    const survivor = await homes([ids.b]);
    expect(survivor.length, "remove ungroups a tab; it must NOT close it").toBe(1);
    expect(survivor[0]?.windowId).toBe(ids.w);
  });

  test("remove --group dissolves the group and every tab survives", async () => {
    test.info().annotations.push({ type: "surface", description: "group_tabs:dissolve" });
    // The capability George actually asked for: get rid of a group WITHOUT
    // losing its tabs. Only a real browser can prove the group is gone — a fake
    // cannot delete something Chrome deletes implicitly, because
    // chrome.tabGroups has no delete call at all: a group disappears when its
    // last tab leaves, so ungrouping is both the only mechanism AND the reason
    // no tab can be destroyed by it.
    const ids = await stack.sw.evaluate(
      async (urls) => {
        const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
        const w = await c.windows.create({ url: urls[0], focused: true });
        const a = w.tabs?.[0]?.id as number;
        const b = (await c.tabs.create({ windowId: w.id as number, url: urls[1] })).id as number;
        // A tab in the SAME window but outside the group — the control that
        // catches a dissolve which ungroups more than it was asked to.
        const outsider = (await c.tabs.create({ windowId: w.id as number, url: urls[2] }))
          .id as number;
        return { w: w.id as number, a, b, outsider };
      },
      [server.url("/u/d1"), server.url("/u/d2"), server.url("/u/d3")],
    );

    const created = JSON.parse(
      await groupCli([
        "create",
        "--tabs",
        `${stack.tabHandle(ids.a)},${stack.tabHandle(ids.b)}`,
        "--title",
        "dissolve-me",
      ]),
    ) as { groupId: string };
    const gid = (await homes([ids.a]))[0]?.groupId as number;
    expect(gid, "the two tabs are really grouped before we dissolve").toBeGreaterThanOrEqual(0);

    // Dissolve by GROUP handle alone — no tab ids. This is the form the schema
    // and CLI help advertised while the implementation rejected it.
    const out = JSON.parse(await groupCli(["remove", "--group", created.groupId])) as {
      ok: boolean;
    };
    expect(out.ok).toBe(true);

    // 1. Both members are ungrouped...
    await expect
      .poll(async () => (await homes([ids.a, ids.b])).every((t) => t.groupId === -1), {
        timeout: 10_000,
      })
      .toBe(true);

    // 2. ...and BOTH TABS STILL EXIST. This is the whole point.
    const survivors = await homes([ids.a, ids.b]);
    expect(survivors.length, "dissolving a group must not close its tabs").toBe(2);
    expect(survivors.every((t) => t.windowId === ids.w)).toBe(true);

    // 3. The group itself is gone from chrome.tabGroups — asked of the browser,
    //    not inferred from the daemon snapshot.
    const groupGone = await stack.sw.evaluate(async (g) => {
      const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      try {
        await c.tabGroups.get(g);
        return false;
      } catch {
        return true;
      }
    }, gid);
    expect(groupGone, "an emptied group is deleted by Chrome itself").toBe(true);

    // 4. The outsider was never touched — proves the dissolve was scoped.
    const outsider = await homes([ids.outsider]);
    expect(outsider.length, "the ungrouped bystander must survive untouched").toBe(1);
    expect(outsider[0]?.groupId).toBe(-1);
  });

  test("a list-taking action reports stale ids instead of failing outright", async () => {
    test.info().annotations.push({ type: "surface", description: "group_tabs:stale" });
    // Documented contract: per-id validation, stale ids skipped and reported
    // back as handles in `payload.skippedTabIds`, all-stale errors. Only a real
    // browser can produce a genuinely dead id — closing a tab and reusing its
    // handle is the honest way to make one.
    const ids = await stack.sw.evaluate(
      async (urls) => {
        const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
        const w = await c.windows.create({ url: urls[0], focused: true });
        const live = w.tabs?.[0]?.id as number;
        const doomed = (await c.tabs.create({ windowId: w.id as number, url: urls[1] }))
          .id as number;
        await c.tabs.remove(doomed);
        return { live, doomed };
      },
      [server.url("/u/g5"), server.url("/u/g6")],
    );

    const result = JSON.parse(
      await groupCli([
        "create",
        "--tabs",
        [stack.tabHandle(ids.live), stack.tabHandle(ids.doomed)].join(","),
        "--title",
        "partial",
      ]),
    ) as { ok: boolean; payload?: { skippedTabIds?: string[] } };

    expect(result.ok, "one live id is enough to succeed").toBe(true);
    expect(
      result.payload?.skippedTabIds,
      "the caller must be TOLD which ids were dropped, as handles",
    ).toEqual([stack.tabHandle(ids.doomed)]);
  });

  test("an all-stale request errors rather than silently doing nothing", async () => {
    test.info().annotations.push({ type: "surface", description: "group_tabs:all-stale" });
    const doomed = await stack.sw.evaluate(async (u) => {
      const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      const t = (await c.tabs.create({ url: u })).id as number;
      await c.tabs.remove(t);
      return t;
    }, server.url("/u/g7"));

    await expect(
      groupCli(["create", "--tabs", stack.tabHandle(doomed), "--title", "nothing"]),
    ).rejects.toThrow();
  });
  test("move relocates the whole group to another window", async () => {
    test.info().annotations.push({ type: "surface", description: "group_tabs:move" });
    const ids = await stack.sw.evaluate(
      async (urls) => {
        const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
        const w1 = await c.windows.create({ url: urls[0], focused: true });
        const a = w1.tabs?.[0]?.id as number;
        const b = (await c.tabs.create({ windowId: w1.id as number, url: urls[1] })).id as number;
        const w2 = await c.windows.create({ url: "about:blank", focused: false });
        return { w1: w1.id as number, w2: w2.id as number, a, b };
      },
      [server.url("/u/g8"), server.url("/u/g9")],
    );

    const created = JSON.parse(
      await groupCli([
        "create",
        "--tabs",
        [stack.tabHandle(ids.a), stack.tabHandle(ids.b)].join(","),
        "--title",
        "travelling",
      ]),
    ) as { groupId: string };

    expect(
      JSON.parse(
        await groupCli([
          "move",
          "--group",
          created.groupId,
          "--target-window",
          stack.windowHandle(ids.w2),
          "--index",
          "-1",
        ]),
      ).ok,
    ).toBe(true);

    // Here relocation IS the point — the inverse of the create test. Both
    // tabs must move, together, and stay grouped.
    await expect
      .poll(async () => (await homes([ids.a, ids.b])).every((t) => t.windowId === ids.w2), {
        timeout: 10_000,
        intervals: [250],
      })
      .toBe(true);
    const moved = await homes([ids.a, ids.b]);
    expect(moved[0]?.groupId, "still one group after the move").toBe(moved[1]?.groupId);
    expect(moved[0]?.groupId).toBeGreaterThan(0);
  });
});
