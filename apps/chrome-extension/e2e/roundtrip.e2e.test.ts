/**
 * Full round-trip: the BUILT extension in a real (new-headless) Chromium
 * connects to a throwaway, HOME-isolated daemon over loopback, and a daemon-
 * driven cross-window move executes via `chrome.tabs.move` — preserving the
 * page's scroll position (the crown-jewel behavior vs a state-losing
 * close+reopen). This is the one test that proves hello→helloAck→snapshot and
 * the command path end-to-end through a real browser.
 */

import type { BrowserContext, Worker } from "@playwright/test";
import {
  assertExtensionFresh,
  type Daemon,
  EXPECTED_BROWSER,
  expect,
  launchExtension,
  seedConfig,
  startDaemon,
  test,
} from "./fixtures.js";

// Short data: page so the daemon's sanitized url stays intact; tall body so
// there's somewhere to scroll.
const TALL = `data:text/html,<body style="height:4000px;margin:0">${"BTMARK"}</body>`;
const SCROLL_Y = 1200;

test.describe.configure({ mode: "serial" });

test.describe("extension ↔ daemon round-trip", () => {
  let daemon: Daemon;
  let context: BrowserContext;
  let extensionId: string;
  let userDataDir: string;
  let sw: Worker;

  test.beforeAll(async () => {
    daemon = await startDaemon(import.meta.url);
    ({ context, extensionId, userDataDir } = await launchExtension());
    // `serviceWorkers()[0]` is `Worker | undefined` under
    // noUncheckedIndexedAccess — assign through a local so the narrowing
    // actually applies, rather than destructuring into an already-typed `sw`.
    const existing = context.serviceWorkers()[0];
    sw = existing ?? (await context.waitForEvent("serviceworker"));
    await seedConfig(context, extensionId, daemon);

    // Wait until the daemon is actually extension-AUTHORITATIVE — not merely
    // that `extensions` lists chrome (which flips the moment `hello` registers
    // the session, a beat before the first snapshot merges).
    await expect
      .poll(
        async () => {
          const snap = JSON.parse(await daemon.cli(["list", "--json"]));
          const chrome = (snap.browsers as Array<Record<string, unknown>>).find(
            (b) => b.browser === EXPECTED_BROWSER,
          );
          return chrome?.dataSource ?? "none";
        },
        { timeout: 20_000, intervals: [250] },
      )
      .toBe("extension");

    // Now that a session exists, prove it is THIS tree's bundle. A stale dist/
    // reports no capabilities, so the rest of this file would degrade into
    // graceful refusals that look like product limits.
    await assertExtensionFresh(daemon);
  });

  test.afterAll(async () => {
    await context?.close();
    await daemon?.stop();
    if (userDataDir) {
      const { rmSync } = await import("node:fs");
      rmSync(userDataDir, { recursive: true, force: true });
    }
  });

  test("the daemon serves the real extension's tabs with x-handles", async () => {
    // Read by e2e/run-guard.ts: the ledger claims `list_tabs` is effect-verified
    // on this tier, and this annotation is what makes that claim checkable. Drop
    // it and the run fails with the surface named.
    test.info().annotations.push({ type: "surface", description: "list_tabs" });
    const snap = JSON.parse(await daemon.cli(["list", "--json"]));
    const chrome = (snap.browsers as Array<Record<string, unknown>>).find(
      (b) => b.browser === EXPECTED_BROWSER,
    );
    expect(chrome, `${EXPECTED_BROWSER} browser present in snapshot`).toBeTruthy();
    expect(chrome?.dataSource).toBe("extension");
    expect(chrome?.extensionConnected).toBe(true);
    // This job runs on Linux: no osascript, so the "poll" is the unavailable
    // adapter reporting running:false — exactly an extension-only platform.
    // The merge must let the live socket outrank that (the Windows deployment
    // bug, 2026-08-21: a connected browser rendered as "not running").
    expect(chrome?.running, "live extension feed must mean running=true").toBe(true);
    const windows = (chrome?.windows ?? []) as Array<Record<string, unknown>>;
    expect(String(windows[0]?.windowId)).toMatch(new RegExp(`^w:${EXPECTED_BROWSER}:x\\d+$`));
  });

  test("a daemon-driven cross-window move preserves scroll", async () => {
    test.info().annotations.push({ type: "surface", description: "move_tab" });
    // Two real windows: one with a tall page, one empty target.
    const ids = await sw.evaluate(async (tall) => {
      const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      const w1 = await c.windows.create({ url: tall, focused: true });
      const w2 = await c.windows.create({ url: "about:blank" });
      return {
        tallTabId: w1.tabs?.[0]?.id as number,
        win2Id: w2.id as number,
      };
    }, TALL);

    // Grab the Playwright Page for the tall tab and scroll it.
    await expect
      .poll(() => context.pages().some((p) => p.url().includes("BTMARK")), { timeout: 10_000 })
      .toBe(true);
    const tallPage = context.pages().find((p) => p.url().includes("BTMARK"));
    if (!tallPage) throw new Error("tall page not found");
    await tallPage.evaluate((y) => window.scrollTo(0, y), SCROLL_Y);
    expect(await tallPage.evaluate(() => Math.round(window.scrollY))).toBe(SCROLL_Y);

    // Handles follow the documented extension-generation grammar (x-ids).
    const tabHandle = `t:${EXPECTED_BROWSER}:x${ids.tallTabId}`;
    const targetWindow = `w:${EXPECTED_BROWSER}:x${ids.win2Id}`;

    // Move via the daemon → WS → real chrome.tabs.move.
    await daemon.cli(["move", tabHandle, "--target-window", targetWindow]);

    // The daemon's snapshot now places the tab under the target window…
    await expect
      .poll(
        async () => {
          const snap = JSON.parse(await daemon.cli(["list", "--json"]));
          const chrome = (snap.browsers as Array<Record<string, unknown>>).find(
            (b) => b.browser === EXPECTED_BROWSER,
          );
          const windows = (chrome?.windows ?? []) as Array<Record<string, unknown>>;
          const target = windows.find((w) => w.windowId === targetWindow);
          return (
            (target?.tabs as Array<Record<string, unknown>> | undefined)?.some(
              (t) => t.tabId === tabHandle,
            ) ?? false
          );
        },
        { timeout: 10_000, intervals: [250] },
      )
      .toBe(true);

    // …and the page kept its scroll (no reload — the whole point of the ext move).
    expect(await tallPage.evaluate(() => Math.round(window.scrollY))).toBe(SCROLL_Y);
  });
});
