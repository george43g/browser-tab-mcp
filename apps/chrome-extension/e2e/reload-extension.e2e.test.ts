/**
 * `reload-extension` — the dev deploy loop, isolated, and asserting only the
 * half this environment can actually observe.
 *
 * TRUE ZERO COVERAGE UNTIL NOW. Confirmed by exhaustive grep: no test file
 * anywhere referenced the client function, the daemon handler, or the CLI
 * action. Not "thin", not "fake-only" — nothing.
 *
 * WHY ITS OWN FILE. `chrome.runtime.reload()` tears down the MV3 service
 * worker, so every later `sw.evaluate` in the same file throws on a dead
 * execution context. Everything below is therefore daemon-side.
 *
 * TWO MEASUREMENTS, 2026-08-24, that decide what is asserted:
 *
 *  1. **The reloaded worker never comes back under `--headless=new`.** Polled
 *     for 40s after a reload: the browser stayed out of `daemon status`'s
 *     `extensions` list the whole time. MV3 workers are event-driven, and a
 *     `--load-extension` headless context does not appear to restart one after
 *     `runtime.reload()`. On a real headed Chrome it does — that is the dev
 *     loop George runs daily. So the RECONNECT half is an environment limit
 *     here, not a product claim, and is not asserted.
 *  2. **The CLI reports a timeout even though the command worked.** The IPC
 *     client's `REQUEST_TIMEOUT_MS` is 15s (`client/daemon-client.ts:17`)
 *     while the daemon's own reload wait is up to 25s
 *     (`RELOAD_DOWN_TIMEOUT_MS` 5s + `RELOAD_UP_TIMEOUT_MS` 20s). The client
 *     gives up before the operation it is waiting for can finish. Recorded as
 *     BACKLOG B14; the test tolerates the timeout rather than pretending it
 *     does not happen.
 *
 * WHAT IS LEFT IS STILL WORTH HAVING, and is the part no fake can supply: the
 * command reaches a REAL extension and really tears it down. A stub that
 * answered `ok` without touching anything passes every unit test and fails
 * the teardown assertion below.
 */

import { EXPECTED_BROWSER, expect, type Stack, startStack, test } from "./fixtures.js";

test.describe.configure({ mode: "serial" });

test.describe("reload-extension", () => {
  let stack: Stack;

  const connected = async (): Promise<boolean> => {
    const s = (await stack.daemon.status()) as { extensions?: string[] };
    return (s.extensions ?? []).includes(EXPECTED_BROWSER);
  };

  test.beforeAll(async () => {
    stack = await startStack(import.meta.url);
  });

  test.afterAll(async () => {
    // Tolerant: the worker was deliberately destroyed mid-test.
    await stack?.close().catch(() => {});
  });

  test("errors clearly for a browser with no connected extension", async () => {
    test.info().annotations.push({ type: "surface", description: "reload-extension:refusal" });
    // FIRST, deliberately: it needs a live extension session to be meaningful,
    // and the reload test below destroys one. The dev loop's worst outcome
    // would be a cheerful `ok` that reloaded nothing.
    expect(await connected(), "precondition: chrome is connected, brave is not").toBe(true);
    await expect(
      stack.daemon.cli(["reload-extension", "--browser", "brave", "--json"]),
    ).rejects.toThrow();
  });

  test("reaches a real extension and really tears it down", async () => {
    test.info().annotations.push({ type: "surface", description: "reload-extension" });
    expect(await connected(), "precondition: the extension is connected").toBe(true);

    // Tolerated, not ignored — see measurement 2 in the header. The command's
    // EFFECT is what is asserted, and the effect is observable regardless of
    // how the client's wait ends.
    await stack.daemon
      .cli(["reload-extension", "--browser", EXPECTED_BROWSER, "--json"])
      .catch(() => "");

    await expect.poll(connected, { timeout: 30_000, intervals: [500] }).toBe(false);
  });
});
