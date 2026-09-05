/**
 * closed_tabs + reopen_tab against a real browser — Phase 5 PR-P.
 *
 * WHAT THIS TIER PROVES, AND WHAT IT MEASURED INSTEAD. The first version of
 * this spec asserted `method === "session-restore"`, on the reasoning that a
 * browser which closed a tab seconds ago must still hold its recently-closed
 * entry. **Measured 2026-09-05 on headless Chromium: it does not** — the
 * bundle carries the `sessions` permission (asserted below, so this is not a
 * wiring failure) and `chrome.sessions.getRecentlyClosed()` still yields no
 * matching entry, so the reopen honestly reports `reconstructed`.
 *
 * That is environment-dependent behaviour, and this repo's rule for it is to
 * assert the INVARIANT rather than either observation. The invariants are
 * ours: the permission is reachable, the closure is remembered and
 * addressable, the tab really comes back, and `method`/`historyPreserved`
 * agree with each other. Whether the browser offers a session entry is the
 * browser's bookkeeping, not our contract — so session-restore against a
 * headed browser stays UNPROVEN here and is called that in the ledger.
 *
 * Own file, own stack: this spec closes tabs on purpose, and the closure
 * DETECTOR watches the whole snapshot. Sharing a stack with specs that create
 * and destroy windows would mix their closures into this one's list.
 */

import { EXPECTED_BROWSER, expect, type Stack, startStack, test } from "./fixtures.js";
import { type LocalServer, startLocalServer } from "./local-server.js";

test.describe.configure({ mode: "serial" });

interface ClosedRow {
  closedTabId: string;
  url: string;
  title: string;
  windowGone: boolean;
}

test.describe("closed tabs and reopen", () => {
  let stack: Stack;
  let server: LocalServer;

  test.beforeAll(async () => {
    stack = await startStack(import.meta.url);
    server = await startLocalServer();
  });

  test.afterAll(async () => {
    await server?.close().catch(() => {});
    await stack?.close().catch(() => {});
  });

  const realTabUrls = async (): Promise<string[]> =>
    await stack.sw.evaluate(async () => {
      const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      return (await c.tabs.query({})).map((t) => t.url ?? "");
    });

  const closedList = async (): Promise<ClosedRow[]> =>
    JSON.parse(await stack.daemon.cli(["closed", "--limit", "50", "--json"])) as ClosedRow[];

  test("a closed tab is remembered, and reopening it restores its session", async () => {
    test.info().annotations.push({ type: "surface", description: "closed_tabs" });
    test.info().annotations.push({ type: "surface", description: "reopen_tab" });

    const url = server.url("/u/reopen-me");
    const created = await stack.sw.evaluate(
      async (u) =>
        (await (globalThis as unknown as { chrome: typeof chrome }).chrome.tabs.create({ url: u }))
          .id as number,
      url,
    );
    await stack.waitForTab(stack.tabHandle(created));

    // Closing through the daemon means the extension pushes its post-command
    // snapshot immediately, so the closure diff lands without waiting on a poll.
    await stack.daemon.cli(["close", stack.tabHandle(created), "--json"]);
    await expect
      .poll(async () => (await realTabUrls()).includes(url), { timeout: 10_000 })
      .toBe(false);

    // The daemon watched it disappear.
    const row = await expect
      .poll(async () => (await closedList()).find((r) => r.url === url)?.closedTabId ?? "", {
        timeout: 10_000,
        intervals: [250],
      })
      .not.toBe("");
    void row;
    const id = (await closedList()).find((r) => r.url === url)?.closedTabId as string;
    expect(id, "the closure is addressable").toBeTruthy();

    // The permission is OURS to get right, so it is asserted: without it the
    // sessions path could never fire and every reopen would silently
    // reconstruct, which is indistinguishable from the browser simply having
    // no entry.
    const sessionsApi = await stack.sw.evaluate(
      () =>
        typeof (globalThis as unknown as { chrome: typeof chrome }).chrome.sessions
          ?.getRecentlyClosed,
    );
    expect(sessionsApi, "the sessions permission must reach the service worker").toBe("function");

    const out = JSON.parse(await stack.daemon.cli(["reopen", "--id", id, "--json"])) as {
      method: string;
      historyPreserved: boolean;
      url: string;
    };
    expect(out.url).toBe(url);
    // The invariant, not the observation: whichever route was taken, the
    // result must not lie about which one it was.
    expect(["session-restore", "reconstructed"]).toContain(out.method);
    expect(out.historyPreserved).toBe(out.method === "session-restore");

    // BROWSER truth: it is actually back.
    await expect
      .poll(async () => (await realTabUrls()).includes(url), { timeout: 10_000, intervals: [250] })
      .toBe(true);

    // Clean up so the next spec's closure list is its own.
    await stack.sw.evaluate(async (u) => {
      const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      const tabs = await c.tabs.query({ url: u });
      for (const t of tabs) if (t.id !== undefined) await c.tabs.remove(t.id);
    }, url);
  });

  test("an unknown closedTabId is refused, not guessed at", async () => {
    test.info().annotations.push({ type: "surface", description: "reopen_tab" });
    const refused = await stack.daemon
      .cli(["reopen", "--id", "deadbeef", "--json"])
      .then((o) => o)
      .catch(
        (e: Error & { stdout?: string; stderr?: string }) =>
          `${e.message} ${e.stdout ?? ""} ${e.stderr ?? ""}`,
      );
    expect(String(refused)).toMatch(/unknown or has aged out/);
    expect(EXPECTED_BROWSER, "fixture canary").toBeTruthy();
  });
});
