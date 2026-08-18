/**
 * The bookmarks TOOL's own guards.
 *
 * `url-policy.test.ts` proves `checkUrl` classifies schemes correctly; that is
 * not the same as proving this tool CALLS it. A sabotage that removed the check
 * here left that suite green — so the boundary needs its own test.
 */

import { describe, expect, it, vi } from "vitest";

const calls: Record<string, unknown>[] = [];
vi.mock("../client/tabs-service.js", () => ({
  bookmarks: async (params: Record<string, unknown>) => {
    calls.push(params);
    return { action: params.action, browser: "chrome", nodes: [], truncated: false };
  },
}));

const { bookmarksTool } = await import("./bookmarks.js");

const run = (input: Record<string, unknown>) =>
  // biome-ignore lint/suspicious/noExplicitAny: exercising the handler directly.
  (bookmarksTool.handler as any)({ action: "search", maxResults: 100, recursive: false, ...input });

describe("bookmarks tool guards", () => {
  it("refuses a javascript: URL — a bookmark is a PERSISTENT clickable trap", () => {
    return expect(
      run({ action: "create", title: "x", url: "javascript:alert(1)" }),
    ).rejects.toThrow(/not allowed/i);
  });

  it("says why a bookmark is worse than a one-off navigation", async () => {
    await expect(run({ action: "create", url: "file:///etc/passwd" })).rejects.toThrow(
      /persists and is user-clickable/,
    );
  });

  it("lets an ordinary https bookmark through", async () => {
    calls.length = 0;
    await run({ action: "create", title: "ok", url: "https://example.com" });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "https://example.com" });
  });

  it("demands an id for update and remove, naming where to get one", async () => {
    // Without this the extension throws a bare "needs an id" from inside the
    // browser, which reaches the caller with no hint about how to find one.
    await expect(run({ action: "remove" })).rejects.toThrow(/needs id/);
    await expect(run({ action: "update" })).rejects.toThrow(/action:"search"/);
  });

  it("does not require a url — omitting it is how you create a FOLDER", async () => {
    calls.length = 0;
    await run({ action: "create", title: "Reading" });
    expect(calls[0]).not.toHaveProperty("url");
  });

  it("honours cancellation before touching the daemon", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    // biome-ignore lint/suspicious/noExplicitAny: exercising the handler directly.
    await expect((bookmarksTool.handler as any)({ action: "search" }, ctrl.signal)).rejects.toThrow(
      /Cancelled/,
    );
  });

  it("is marked destructive — remove() deletes a whole subtree", () => {
    // No other tool here removes more than the thing you named.
    expect(bookmarksTool.annotations?.destructiveHint).toBe(true);
    expect(bookmarksTool.annotations?.readOnlyHint).toBe(false);
  });
});
