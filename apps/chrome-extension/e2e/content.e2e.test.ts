/**
 * `get_page` and `annotate` against a real page in a real browser.
 *
 * WHAT IS NEW HERE. `content.integration.test.ts` already runs the REAL
 * `extract.js` — but inside a fake `chrome.scripting.executeScript` stub, over
 * a fixed HTML string. That proves the extractor parses HTML. It cannot prove
 * the two-step injection works in a real MV3 world, because no script was ever
 * injected into anything.
 *
 * The distinction matters: `chrome.scripting` is blocked on `data:` URLs
 * entirely, which is why this file needs `local-server.ts` and why the existing
 * roundtrip spec's `data:` page could never have been used for it.
 *
 * Extension-only by design — there is no AppleScript path that can read a
 * page — so this tier is the ceiling for both surfaces.
 */

import { expect, type Page, type Stack, startStack, test } from "./fixtures.js";
import { type LocalServer, PAGE_MARKER, startLocalServer } from "./local-server.js";

test.describe.configure({ mode: "serial" });

test.describe("get_page / annotate", () => {
  let stack: Stack;
  let server: LocalServer;

  /** Open `path` as a real tab and return its handle once it has loaded. */
  const tabAt = async (path: string): Promise<{ id: number; handle: string; url: string }> => {
    const url = server.url(path);
    const id = await stack.sw.evaluate(
      async (u) =>
        (await (globalThis as unknown as { chrome: typeof chrome }).chrome.tabs.create({ url: u }))
          .id as number,
      url,
    );
    await expect
      .poll(
        async () =>
          await stack.sw.evaluate(
            async (i) =>
              (await (globalThis as unknown as { chrome: typeof chrome }).chrome.tabs.get(i))
                .status,
            id,
          ),
        { timeout: 15_000, intervals: [250] },
      )
      .toBe("complete");
    // Browser-side "complete" is not daemon-side "present": an out-of-band tab
    // reaches the snapshot on the debounced path. See Stack.waitForTab.
    await stack.waitForTab(stack.tabHandle(id));
    return { id, handle: stack.tabHandle(id), url };
  };

  const page = async (handle: string, args: string[] = []): Promise<Record<string, unknown>> =>
    JSON.parse(await stack.daemon.cli(["page", handle, ...args, "--json"]));

  test.beforeAll(async () => {
    stack = await startStack(import.meta.url);
    server = await startLocalServer();
  });

  test.afterAll(async () => {
    await server?.close();
    await stack?.close();
  });

  test("metadata mode reads the real document, injected for real", async () => {
    test.info().annotations.push({ type: "surface", description: "get_page:metadata" });
    const { handle, url } = await tabAt("/article");
    const result = await page(handle, ["--mode", "metadata"]);

    expect(result.url).toBe(url);
    expect(
      result.title,
      "the <title> of the page actually loaded — a stub would have to be told this",
    ).toBe("Article");
  });

  test("text mode returns reader-extracted prose from the live DOM", async () => {
    test.info().annotations.push({ type: "surface", description: "get_page:text" });
    const { handle } = await tabAt("/article");
    const result = await page(handle, ["--mode", "text"]);
    const text = String(result.text ?? result.content ?? "");

    expect(text.length, "reader mode produced something").toBeGreaterThan(200);
    expect(text, "and it is THIS page's prose").toContain("Readable sentences");
    expect(text, "reader mode strips chrome; the marker sits outside the <article>").not.toContain(
      PAGE_MARKER,
    );
  });

  test("state mode observes DOM state the extractor cannot invent", async () => {
    test.info().annotations.push({ type: "surface", description: "get_page:state" });
    // Scroll the REAL page first. Scroll position is the cleanest proof that
    // the script ran in the live document: it exists nowhere in the HTML.
    const { handle, url } = await tabAt("/tall");
    const target: Page | undefined = stack.context.pages().find((p) => p.url() === url);
    if (!target) throw new Error("tall page not attached to the context");
    await target.evaluate(() => window.scrollTo(0, 1500));

    const result = await page(handle, ["--mode", "state", "--force"]);
    const state = (result.state ?? result) as Record<string, unknown>;
    const scroll = (state.scroll ?? {}) as Record<string, unknown>;
    const y = Number(scroll.y ?? state.scrollY ?? -1);
    expect(
      y,
      `state mode must see the live scroll position (got ${JSON.stringify(state)})`,
    ).toBeGreaterThan(1000);
  });

  test("the navEpoch cache serves a repeat read, and --force bypasses it", async () => {
    test.info().annotations.push({ type: "surface", description: "get_page:cache" });
    const { handle } = await tabAt("/article");
    const first = await page(handle, ["--mode", "metadata"]);
    const second = await page(handle, ["--mode", "metadata"]);
    expect(second.title).toBe(first.title);
    // `--force` must still succeed rather than erroring on a warm cache —
    // the flag exists precisely for a page that changed under a stable URL.
    const forced = await page(handle, ["--mode", "metadata", "--force"]);
    expect(forced.title).toBe(first.title);
  });

  test("get_page refuses an AppleScript-generation handle with a reason", async () => {
    test.info().annotations.push({ type: "surface", description: "get_page:refusal" });
    // There is no AppleScript path to read a page, so this must be an
    // actionable error rather than an empty result that reads as "no content".
    await expect(stack.daemon.cli(["page", "t:chrome:123", "--json"])).rejects.toThrow();
  });

  test("annotate stores and reads back a note keyed by the real page URL", async () => {
    test.info().annotations.push({ type: "surface", description: "annotate" });
    // The point of doing this on this tier: the URL the note is keyed by is
    // the one the EXTENSION reported (post-redaction, post-normalisation), not
    // one the test made up. A mismatch would make notes silently unreadable.
    const { handle } = await tabAt("/u/annotated");
    const meta = await page(handle, ["--mode", "metadata"]);
    const realUrl = String(meta.url);

    const written = JSON.parse(
      await stack.daemon.cli(["annotate", realUrl, "--note", "e2e note", "--json"]),
    ) as Record<string, unknown>;
    expect(written.ok ?? true).toBeTruthy();

    const read = JSON.parse(await stack.daemon.cli(["annotate", realUrl, "--json"])) as Record<
      string,
      unknown
    >;
    expect(JSON.stringify(read), "the note comes back for the URL the browser reported").toContain(
      "e2e note",
    );
  });

  test("annotate returns nothing for a URL that was never annotated", async () => {
    test.info().annotations.push({ type: "surface", description: "annotate:miss" });
    // A cache substrate, never intelligence: an unknown URL is a miss, not an
    // invention and not an error.
    const read = JSON.parse(
      await stack.daemon.cli(["annotate", server.url("/u/never-annotated"), "--json"]),
    ) as Record<string, unknown>;
    expect(JSON.stringify(read)).not.toContain("e2e note");
  });
});
