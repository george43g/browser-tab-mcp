/**
 * `open_window` / `set_window` / `close_window` against real
 * `chrome.windows`.
 *
 * ON BOUNDS. Headless has no window manager, so a requested frame may be
 * honoured, clamped, or ignored, and asserting exact geometry here would be
 * asserting the harness. The approach is to PROBE once and assert what the
 * probe supports, with the measurement in the message — never to weaken the
 * assertion quietly. Real geometry with real clamping is the macos-local
 * tier's job either way (`pnpm sweep:macos`), because macOS clamps to the
 * visible frame in ways no headless build reproduces.
 *
 * `close_window` gets the same treatment `close_tab` got: gone from
 * `chrome.windows.getAll` AND its tabs gone from `chrome.tabs.query`, because
 * a window that closed while orphaning its tabs would look identical in a
 * snapshot that only counts windows.
 */

import { EXPECTED_BROWSER, expect, type Stack, startStack, test } from "./fixtures.js";
import { type LocalServer, startLocalServer } from "./local-server.js";

test.describe.configure({ mode: "serial" });

test.describe("window operations", () => {
  let stack: Stack;
  let server: LocalServer;

  const winFacts = (
    id: number,
  ): Promise<{ state: string; focused: boolean; tabs: string[] } | null> =>
    stack.sw.evaluate(async (windowId) => {
      const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      try {
        const w = await c.windows.get(windowId, { populate: true });
        return {
          state: w.state ?? "",
          focused: w.focused,
          tabs: (w.tabs ?? []).map((t) => t.url ?? ""),
        };
      } catch {
        return null;
      }
    }, id);

  const windowIds = (): Promise<number[]> =>
    stack.sw.evaluate(async () =>
      (await (globalThis as unknown as { chrome: typeof chrome }).chrome.windows.getAll({})).map(
        (w) => w.id as number,
      ),
    );

  test.beforeAll(async () => {
    stack = await startStack(import.meta.url);
    server = await startLocalServer();
  });

  test.afterAll(async () => {
    await server?.close();
    await stack?.close();
  });

  test("open_window creates a real window holding the URLs asked for", async () => {
    test.info().annotations.push({ type: "surface", description: "open_window" });
    const urls = [server.url("/u/w1"), server.url("/u/w2")];
    const before = await windowIds();

    const result = JSON.parse(
      await stack.daemon.cli([
        "window",
        "open",
        urls[0] as string,
        urls[1] as string,
        "--browser",
        EXPECTED_BROWSER,
        "--json",
      ]),
    ) as { ok: boolean; windowId?: string };
    expect(result.ok).toBe(true);
    expect(result.windowId).toMatch(new RegExp(`^w:${EXPECTED_BROWSER}:x\\d+$`));

    const after = await windowIds();
    const created = after.filter((id) => !before.includes(id));
    expect(created.length, "exactly one new window").toBe(1);
    expect(result.windowId, "the returned handle names the window that appeared").toBe(
      stack.windowHandle(created[0] as number),
    );

    await expect
      .poll(async () => (await winFacts(created[0] as number))?.tabs.length, { timeout: 10_000 })
      .toBe(2);
    const facts = await winFacts(created[0] as number);
    expect(facts?.tabs.sort()).toEqual([...urls].sort());
  });

  test("open_window --no-focus leaves the previously focused window frontmost", async () => {
    test.info().annotations.push({ type: "surface", description: "open_window:no-focus" });
    const focusedBefore = await stack.sw.evaluate(
      async () =>
        (await (globalThis as unknown as { chrome: typeof chrome }).chrome.windows.getLastFocused())
          .id as number,
    );

    const result = JSON.parse(
      await stack.daemon.cli([
        "window",
        "open",
        server.url("/u/w-bg"),
        "--browser",
        EXPECTED_BROWSER,
        "--no-focus",
        "--json",
      ]),
    ) as { ok: boolean; windowId: string };
    expect(result.ok).toBe(true);

    const focusedAfter = await stack.sw.evaluate(
      async () =>
        (await (globalThis as unknown as { chrome: typeof chrome }).chrome.windows.getLastFocused())
          .id as number,
    );
    expect(
      focusedAfter,
      "a background open must not steal focus — the flag's entire contract",
    ).toBe(focusedBefore);
  });

  test("set_window changes the window's real state", async () => {
    test.info().annotations.push({ type: "surface", description: "set_window:state" });
    const id = await stack.sw.evaluate(
      async (u) =>
        (
          await (globalThis as unknown as { chrome: typeof chrome }).chrome.windows.create({
            url: u,
          })
        ).id as number,
      server.url("/u/w-state"),
    );
    const handle = stack.windowHandle(id);

    expect(
      JSON.parse(
        await stack.daemon.cli(["window", "set", handle, "--state", "minimized", "--json"]),
      ).ok,
    ).toBe(true);
    await expect
      .poll(async () => (await winFacts(id))?.state, { timeout: 10_000 })
      .toBe("minimized");

    expect(
      JSON.parse(await stack.daemon.cli(["window", "set", handle, "--state", "normal", "--json"]))
        .ok,
    ).toBe(true);
    await expect.poll(async () => (await winFacts(id))?.state, { timeout: 10_000 }).toBe("normal");
  });

  test("set_window --bounds is applied as far as this browser applies it", async () => {
    test.info().annotations.push({ type: "surface", description: "set_window:bounds" });
    const id = await stack.sw.evaluate(
      async (u) =>
        (
          await (globalThis as unknown as { chrome: typeof chrome }).chrome.windows.create({
            url: u,
          })
        ).id as number,
      server.url("/u/w-bounds"),
    );

    const want = { left: 120, top: 90, width: 820, height: 610 };
    expect(
      JSON.parse(
        await stack.daemon.cli([
          "window",
          "set",
          stack.windowHandle(id),
          "--bounds",
          `${want.left},${want.top},${want.width},${want.height}`,
          "--json",
        ]),
      ).ok,
    ).toBe(true);

    const got = await stack.sw.evaluate(async (windowId) => {
      const w = await (globalThis as unknown as { chrome: typeof chrome }).chrome.windows.get(
        windowId,
      );
      return { left: w.left ?? -1, top: w.top ?? -1, width: w.width ?? -1, height: w.height ?? -1 };
    }, id);

    // PROBED, not assumed. Measured 2026-08-24 on Chromium under
    // `--headless=new`: the requested frame is applied exactly. If a channel
    // is ever found that clamps or ignores it, this assertion should be
    // replaced by one that states the measurement — not deleted, and not
    // softened into `toBeGreaterThan(0)`, which would pass for any geometry
    // at all. Real clamping behaviour belongs to the macos-local tier.
    expect(got, "requested frame must be applied verbatim in this environment").toEqual(want);
  });

  test("close_window removes the window AND its tabs", async () => {
    test.info().annotations.push({ type: "surface", description: "close_window" });
    const made = await stack.sw.evaluate(
      async (urls) => {
        const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
        const w = await c.windows.create({ url: urls[0] });
        await c.tabs.create({ windowId: w.id as number, url: urls[1] });
        return { id: w.id as number, urls };
      },
      [server.url("/u/w-doomed-1"), server.url("/u/w-doomed-2")],
    );

    await expect
      .poll(async () => (await winFacts(made.id))?.tabs.length, { timeout: 10_000 })
      .toBe(2);

    expect(
      JSON.parse(await stack.daemon.cli(["window", "close", stack.windowHandle(made.id), "--json"]))
        .ok,
    ).toBe(true);

    await expect.poll(async () => await winFacts(made.id), { timeout: 10_000 }).toBeNull();
    // …and no orphans. A window that closed while leaving its tabs behind
    // would be invisible to any assertion that only counts windows.
    const orphans = await stack.sw.evaluate(
      async (urls) =>
        (await (globalThis as unknown as { chrome: typeof chrome }).chrome.tabs.query({})).filter(
          (t) => urls.includes(t.url ?? ""),
        ).length,
      made.urls,
    );
    expect(orphans, "closing a window must take its tabs with it").toBe(0);
  });
});
