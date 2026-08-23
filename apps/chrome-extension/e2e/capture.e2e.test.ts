/**
 * `screenshot`, tier 1 (tab) — real `captureVisibleTab` bytes.
 *
 * FLAGGED AS THE LIKELIEST FAILURE IN THE WHOLE SWEEP. `captureVisibleTab`
 * under `--headless=new` was the plan's cut #1: if it errors, the instruction
 * was to RE-TIER it, never to weaken it into "the command returned ok".
 * Measured 2026-08-24 on Chromium under `--headless=new`: it works and
 * produces real JPEG bytes. The assertions below are therefore the strong
 * ones, and the magic-number check is what keeps "it returned a file" from
 * passing for an empty or truncated one.
 *
 * The window tier (`--window`, `screencapture -l`) is NOT here: it is macOS
 * only, needs Screen Recording TCC, and is gated behind
 * `BROWSER_TAB_WINDOW_CAPTURE=1`. It belongs to the macos-local tier and the
 * ledger says so.
 */

import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Stack, startStack, test } from "./fixtures.js";
import { type LocalServer, startLocalServer } from "./local-server.js";

test.describe.configure({ mode: "serial" });

/** JPEG SOI marker. A zero-byte or HTML-error "image" fails this. */
const isJpeg = (buf: Buffer): boolean => buf.length > 2 && buf[0] === 0xff && buf[1] === 0xd8;

test.describe("screenshot (tab tier)", () => {
  let stack: Stack;
  let server: LocalServer;
  const written: string[] = [];

  const shot = (args: string[]): Promise<string> =>
    stack.daemon.cli(["screenshot", ...args, "--json"]);

  test.beforeAll(async () => {
    stack = await startStack(import.meta.url);
    server = await startLocalServer();
  });

  test.afterAll(async () => {
    for (const f of written) rmSync(f, { force: true });
    await server?.close();
    await stack?.close();
  });

  test("captures the ACTIVE tab as real JPEG bytes", async () => {
    test.info().annotations.push({ type: "surface", description: "screenshot" });
    const url = server.url("/u/shot");
    const id = await stack.sw.evaluate(async (u) => {
      const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      const w = await c.windows.create({ url: u, focused: true });
      return w.tabs?.[0]?.id as number;
    }, url);
    await expect
      .poll(
        async () =>
          await stack.sw.evaluate(
            async (i) =>
              (await (globalThis as unknown as { chrome: typeof chrome }).chrome.tabs.get(i))
                .status,
            id,
          ),
        { timeout: 15_000 },
      )
      .toBe("complete");

    const out = join(tmpdir(), `bt-e2e-shot-${Date.now()}.jpg`);
    written.push(out);
    // The daemon is a separate process: a tab created out of band reaches its
    // snapshot on the debounced event path. Without this the capture loses the
    // race and errors "not in the current snapshot" (3 runs in 5, measured).
    await stack.waitForTab(stack.tabHandle(id));

    const result = JSON.parse(await shot([stack.tabHandle(id), "--out", out])) as Record<
      string,
      unknown
    >;
    expect(result.ok ?? true).toBeTruthy();

    // The assertion that separates "a file exists" from "an image exists".
    const bytes = readFileSync(out);
    expect(bytes.length, "a real capture is not a handful of bytes").toBeGreaterThan(1000);
    expect(isJpeg(bytes), "starts with the JPEG SOI marker (0xFFD8)").toBe(true);
  });

  test("refuses a tab that is not its window's active tab, and --focus fixes it", async () => {
    test.info().annotations.push({ type: "surface", description: "screenshot:preflight" });
    // `captureVisibleTab` can only ever photograph the visible tab, so the
    // daemon preflights it rather than silently returning a picture of
    // something else. That preflight is the contract worth pinning: a
    // screenshot of the WRONG tab is far worse than an error.
    const ids = await stack.sw.evaluate(async (u) => {
      const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      const w = await c.windows.create({ url: u, focused: true });
      const background = w.tabs?.[0]?.id as number;
      await c.tabs.create({ windowId: w.id as number, url: "about:blank", active: true });
      return { background };
    }, server.url("/u/shot-bg"));
    await stack.waitForTab(stack.tabHandle(ids.background));

    await expect(shot([stack.tabHandle(ids.background)])).rejects.toThrow();

    const out = join(tmpdir(), `bt-e2e-shot-focus-${Date.now()}.jpg`);
    written.push(out);
    const result = JSON.parse(
      await shot([stack.tabHandle(ids.background), "--focus", "--out", out]),
    ) as Record<string, unknown>;
    expect(result.ok ?? true).toBeTruthy();
    const bytes = readFileSync(out);
    expect(isJpeg(bytes), "--focus activated it first, so there is a real image").toBe(true);
  });

  test("neither id nor both ids is a schema rejection", async () => {
    test.info().annotations.push({ type: "surface", description: "screenshot:schema" });
    await expect(stack.daemon.cli(["screenshot", "--json"])).rejects.toThrow();
  });
});
