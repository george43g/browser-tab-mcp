/**
 * `tab_action discard` — isolated, and asserting deliberately little.
 *
 * WHY ITS OWN FILE, AND WHY THE ASSERTIONS STOP WHERE THEY DO. Discard is
 * hostile to test in a way no other action is:
 *
 *   1. **The tab id CHANGES.** Measured 3/3 on real Edge (2026-08-22): the
 *      handle the command returns is not the handle it was given, because
 *      Chrome discards by replacing the tab with a fresh, unloaded one. Any
 *      later lookup by the ORIGINAL handle is looking for something that no
 *      longer exists.
 *   2. **The browsing context dies.** After the discard, the Playwright
 *      context that owned the page has been observed to go with it. A
 *      keep-alive page did NOT prevent this, so the obvious explanation is
 *      refuted rather than untried. That is why this file owns its own stack
 *      and its own `afterAll`, which tolerates a dead context.
 *
 * A post-discard `tabs.get` is therefore unreachable BY CONSTRUCTION, not by
 * choice. What is left is still worth pinning, because it is exactly the part
 * that a fake cannot fake: the command reaches a real browser, is accepted,
 * and comes back naming a DIFFERENT tab. A fake `tabs.discard` that returned
 * its input would satisfy every unit test and fail here.
 *
 * Do not "strengthen" this by asserting the discarded tab's state afterwards.
 * That was tried; the measurements above are the result.
 */

import { EXPECTED_BROWSER, expect, type Stack, startStack, test } from "./fixtures.js";
import { type LocalServer, startLocalServer } from "./local-server.js";

test.describe.configure({ mode: "serial" });

test.describe("tab_action discard", () => {
  let stack: Stack;
  let server: LocalServer;

  test.beforeAll(async () => {
    stack = await startStack(import.meta.url);
    server = await startLocalServer();
  });

  test.afterAll(async () => {
    // Tolerant by necessity: the context may already be gone (see header).
    await server?.close().catch(() => {});
    await stack?.close().catch(() => {});
  });

  test("discard is accepted by a real browser and reissues the tab id", async () => {
    test.info().annotations.push({ type: "surface", description: "tab_action:discard" });

    // Two tabs, and discard the INACTIVE one: Chrome refuses to discard the
    // active tab of a window, which would make this a test of our error path
    // rather than of discard.
    const ids = await stack.sw.evaluate(async (url) => {
      const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      const win = await c.windows.create({ url, focused: true });
      const victim = win.tabs?.[0]?.id as number;
      await c.tabs.create({ windowId: win.id as number, url: "about:blank", active: true });
      return { victim, windowId: win.id as number };
    }, server.url("/u/discard"));

    const handle = stack.tabHandle(ids.victim);
    const raw = await stack.daemon.cli(["act", handle, "discard", "--json"]);
    const result = JSON.parse(raw) as { ok: boolean; command: string; tabId?: string };

    expect(result.ok, "a real browser accepted the discard").toBe(true);
    expect(result.command).toBe("tab_action");
    expect(result.tabId, "the reissued id is still a well-formed x-handle").toMatch(
      new RegExp(`^t:${EXPECTED_BROWSER}:x\\d+$`),
    );
    expect(
      result.tabId,
      "THE ASSERTION THIS FILE EXISTS FOR: Chrome replaces the tab, so the id it " +
        "returns is not the id it was given. A fake that echoed its input would " +
        "pass every unit test and fail right here.",
    ).not.toBe(handle);
  });
});
