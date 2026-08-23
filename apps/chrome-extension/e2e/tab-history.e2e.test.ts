/**
 * `tab_action back` / `forward` — session history, driven by a REAL gesture.
 *
 * WHY ITS OWN FILE. Back/forward are the only `tab_action` cases whose
 * precondition is not a tab but a HISTORY: a `chrome.tabs.update({url})`
 * navigation and a scripted `location.href` assignment do not always leave a
 * gesture-marked entry, so `goBack()` on such a tab can land somewhere useless
 * with the command still reporting success. The other actions in
 * `tab-action.e2e.test.ts` need no such setup and should not pay for it.
 *
 * The gesture here is a real Playwright `click()` on a real `<a href>` — not a
 * programmatic navigation. The original plan for this file carried a caveat
 * that back/forward might only be assertable as "did not return to the first
 * page". Measured 2026-08-24 on Chromium under `--headless=new`, a clicked
 * link produces ordinary session history and back/forward land EXACTLY where
 * they should, so the full assertion is made. If a channel is ever found where
 * that is not true, weaken it with the measurement, not by guessing.
 */

import { expect, type Page, type Stack, startStack, test } from "./fixtures.js";
import { type LocalServer, startLocalServer } from "./local-server.js";

test.describe.configure({ mode: "serial" });

test.describe("tab_action back/forward", () => {
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

  test("back returns to the previous page and forward returns to the later one", async () => {
    test.info().annotations.push({ type: "surface", description: "tab_action:back" });
    test.info().annotations.push({ type: "surface", description: "tab_action:forward" });

    const page: Page = await stack.context.newPage();
    await page.goto(server.url("/a"));
    // A REAL click. This is the whole point of the file: the history entry has
    // to be one the browser considers user-initiated.
    await page.click("#to-b");
    await expect.poll(() => page.url(), { timeout: 10_000 }).toBe(server.url("/b"));

    // Find the chrome tab id for this page — the daemon speaks handles, and
    // Playwright's Page has no tab id of its own.
    const tabId = await stack.sw.evaluate(
      async (u) =>
        (await (globalThis as unknown as { chrome: typeof chrome }).chrome.tabs.query({})).find(
          (t) => t.url === u,
        )?.id as number,
      server.url("/b"),
    );
    expect(tabId, "the clicked page must be a findable tab").toBeGreaterThan(0);
    const handle = stack.tabHandle(tabId);

    expect(JSON.parse(await stack.daemon.cli(["act", handle, "back", "--json"])).ok).toBe(true);
    await expect
      .poll(() => page.url(), { timeout: 10_000, intervals: [250] })
      .toBe(server.url("/a"));

    expect(JSON.parse(await stack.daemon.cli(["act", handle, "forward", "--json"])).ok).toBe(true);
    await expect
      .poll(() => page.url(), { timeout: 10_000, intervals: [250] })
      .toBe(server.url("/b"));

    await page.close();
  });

  test("back from a page reached by goto lands on about:blank — because that IS the history", async () => {
    test.info().annotations.push({ type: "surface", description: "tab_action:back-about-blank" });
    // RETIRES AN UNVERIFIED NOTE. Earlier research recorded that back/forward
    // "seemed to land on about:blank" and flagged the observation as
    // unexplained. It is not a browser quirk: a Playwright `newPage()` starts
    // AT `about:blank` and `goto()` navigates away from it, so `about:blank`
    // genuinely is the previous session-history entry. Going back to it is
    // correct behaviour, and the command is doing exactly what it says.
    const page: Page = await stack.context.newPage();
    const only = server.url("/u/from-goto");
    await page.goto(only);
    const tabId = await stack.sw.evaluate(
      async (u) =>
        (await (globalThis as unknown as { chrome: typeof chrome }).chrome.tabs.query({})).find(
          (t) => t.url === u,
        )?.id as number,
      only,
    );

    expect(
      JSON.parse(await stack.daemon.cli(["act", stack.tabHandle(tabId), "back", "--json"])).ok,
    ).toBe(true);
    await expect.poll(() => page.url(), { timeout: 10_000, intervals: [250] }).toBe("about:blank");
    await page.close();
  });

  test("back on a tab with genuinely no history surfaces the browser's own refusal", async () => {
    test.info().annotations.push({ type: "surface", description: "tab_action:back-no-history" });
    // `chrome.tabs.create({url})` loads the URL as the tab's FIRST entry — no
    // about:blank predecessor, unlike the goto case above. Chrome then REJECTS
    // `goBack()` outright ("Cannot find a next page in history."), and the
    // daemon surfaces that through `wrapToolError` rather than swallowing it
    // into a cheerful `ok:true`.
    //
    // This is the only test anywhere that drives a real browser-API rejection
    // through the whole path — extension → WS → daemon → dispatcher → CLI exit
    // code. Every other error-path test rejects at our own boundary, before
    // any browser is involved.
    const only = server.url("/u/first-entry");
    const tabId = await stack.sw.evaluate(
      async (u) =>
        (await (globalThis as unknown as { chrome: typeof chrome }).chrome.tabs.create({ url: u }))
          .id as number,
      only,
    );
    const tabUrl = async (): Promise<string> =>
      stack.sw.evaluate(
        async (i) =>
          (await (globalThis as unknown as { chrome: typeof chrome }).chrome.tabs.get(i)).url ?? "",
        tabId,
      );
    await expect.poll(tabUrl, { timeout: 10_000 }).toBe(only);

    const failure = await stack.daemon.cli(["act", stack.tabHandle(tabId), "back", "--json"]).then(
      () => null,
      (e: { stdout?: string }) => e.stdout ?? "",
    );
    expect(failure, "a rejected browser call must not exit 0").not.toBeNull();
    const parsed = JSON.parse(failure as string) as { error?: { tool?: string; message?: string } };
    expect(parsed.error?.tool).toBe("tab_action");
    expect(
      parsed.error?.message,
      "the browser's own words must survive the trip, not be replaced by ours",
    ).toContain("Cannot find a next page in history");

    // …and the tab did not move.
    await new Promise((r) => setTimeout(r, 500));
    expect(await tabUrl()).toBe(only);
  });
});
