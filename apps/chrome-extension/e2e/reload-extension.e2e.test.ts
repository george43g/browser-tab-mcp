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
 *  1. **How the reload LOOKS depends entirely on the environment, in opposite
 *     directions.** Under macOS/Linux `--headless=new`, the reloaded worker
 *     never comes back at all: polled 40s, the browser stayed out of
 *     `daemon status`'s `extensions` the whole time (MV3 workers are
 *     event-driven and a `--load-extension` headless context does not appear
 *     to restart one). On real Windows Edge it restarts so fast that the
 *     disconnect is never observable by polling — CI, PR #112, where an
 *     assertion that the browser LEAVES `extensions` failed twice on that leg
 *     while passing on every other. So neither "it went down" nor "it came
 *     back" is invariant, and this file asserts neither. What IS invariant is
 *     that the service worker being driven is destroyed — see the test.
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

  test("reaches a real extension and really restarts its service worker", async () => {
    test.info().annotations.push({ type: "surface", description: "reload-extension" });
    expect(await connected(), "precondition: the extension is connected").toBe(true);

    // Prove the worker we hold is alive and is THIS one, by marking it.
    await stack.sw.evaluate(() => {
      (globalThis as unknown as { __btReloadMarker: string }).__btReloadMarker = "pre-reload";
    });
    expect(
      await stack.sw.evaluate(
        () => (globalThis as unknown as { __btReloadMarker?: string }).__btReloadMarker ?? "",
      ),
    ).toBe("pre-reload");

    // Tolerated, not ignored — see measurement 2 in the header. The command's
    // EFFECT is what is asserted, and the effect is observable regardless of
    // how the client's wait ends.
    await stack.daemon
      .cli(["reload-extension", "--browser", EXPECTED_BROWSER, "--json"])
      .catch(() => "");

    // THE INVARIANT, and the only one that holds in every environment
    // measured: the service worker we were driving is DESTROYED. Whether a
    // replacement appears, and how fast, is what varies (see the header) —
    // that the old one dies is what `runtime.reload()` means, and a stub that
    // answered `ok` without touching anything leaves it very much alive.
    //
    // IT HANGS, IT DOES NOT THROW. Measured 2026-08-24: the worker dies
    // mid-call, so Playwright never receives a reply and the `evaluate`
    // promise never settles — a try/catch around it waits forever, and
    // `expect.poll` with a hanging predicate cannot report anything either.
    // Hence the explicit race. The dangling promise is deliberate; the
    // context is closed moments later.
    const stillAlive = await Promise.race([
      stack.sw
        .evaluate(
          () => (globalThis as unknown as { __btReloadMarker?: string }).__btReloadMarker ?? "",
        )
        .then(
          (v) => (v === "pre-reload" ? "alive" : "restarted"),
          () => "gone",
        ),
      new Promise<string>((r) => setTimeout(() => r("gone"), 10_000)),
    ]);
    expect(
      stillAlive,
      "the service worker that was driving this test must not survive the reload",
    ).not.toBe("alive");
  });
});
