/**
 * Options storage unit test. An auto choice resolves from navigator on each
 * load; a saved browser name remains pinned.
 */

import { type FakeChrome, installFakeChrome } from "@george43g/test-kit";
import { afterEach, describe, expect, it, vi } from "vitest";

let fc: FakeChrome | null = null;

afterEach(() => {
  fc?.restore();
  fc = null;
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function freshOptions(ua?: string): Promise<typeof import("./options.js")> {
  vi.resetModules();
  if (ua !== undefined) vi.stubGlobal("navigator", { userAgent: ua });
  fc = installFakeChrome();
  return import("./options.js");
}

describe("loadOptions / saveOptions", () => {
  it("returns defaults when storage is empty", async () => {
    const { loadOptions } = await freshOptions();
    expect(await loadOptions()).toEqual({
      token: "",
      port: 8790,
      browser: expect.any(String),
      browserChoice: "auto",
    });
    expect(fc?.calls["storage.local.get"]?.[0]).toEqual([
      { token: "", port: 8790, browser: "auto" },
    ]);
  });

  it("round-trips saved options through storage.local", async () => {
    const { loadOptions, saveOptions } = await freshOptions();
    await saveOptions({ token: "abc", port: 9999, browser: "brave" });
    expect(fc?.calls["storage.local.set"]?.[0]).toEqual([
      { token: "abc", port: 9999, browser: "brave" },
    ]);
    expect(await loadOptions()).toEqual({
      token: "abc",
      port: 9999,
      browser: "brave",
      browserChoice: "brave",
    });
  });

  it("defaults browser from a Safari UA", async () => {
    const { loadOptions } = await freshOptions("Mozilla/5.0 Version/17.0 Safari/605.1.15");
    expect((await loadOptions()).browser).toBe("safari");
  });

  it("persists auto rather than pinning its current Chrome inference", async () => {
    const { loadOptions, saveOptions } = await freshOptions(
      "Mozilla/5.0 Chrome/152.0 Safari/537.36",
    );
    await saveOptions({ token: "abc", port: 8790, browser: "chrome", browserChoice: "auto" });
    expect(fc?.calls["storage.local.set"]?.[0]).toEqual([
      { token: "abc", port: 8790, browser: "auto" },
    ]);
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 Chrome/152.0 Safari/537.36 ChatGPT Desktop Browser/1.0",
    });
    expect(await loadOptions()).toMatchObject({ browser: "chatgpt", browserChoice: "auto" });
  });

  it("keeps an existing saved Chrome selection pinned after this upgrade", async () => {
    const { loadOptions, saveOptions } = await freshOptions(
      "Mozilla/5.0 Chrome/152.0 Safari/537.36",
    );
    await saveOptions({ token: "abc", port: 8790, browser: "chrome" });
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 Chrome/152.0 Safari/537.36 ChatGPT Desktop Browser/1.0",
    });
    expect(await loadOptions()).toMatchObject({ browser: "chrome", browserChoice: "chrome" });
  });
});
