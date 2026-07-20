/**
 * options storage unit test. DEFAULTS.browser is computed from navigator at
 * MODULE LOAD, so each case re-imports options.js with the global set first.
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
    expect(await loadOptions()).toEqual({ token: "", port: 8790, browser: expect.any(String) });
  });

  it("round-trips saved options through storage.local", async () => {
    const { loadOptions, saveOptions } = await freshOptions();
    await saveOptions({ token: "abc", port: 9999, browser: "brave" });
    expect(fc?.calls["storage.local.set"]?.[0]).toEqual([
      { token: "abc", port: 9999, browser: "brave" },
    ]);
    expect(await loadOptions()).toEqual({ token: "abc", port: 9999, browser: "brave" });
  });

  it("defaults browser from a Safari UA", async () => {
    const { loadOptions } = await freshOptions("Mozilla/5.0 Version/17.0 Safari/605.1.15");
    expect((await loadOptions()).browser).toBe("safari");
  });
});
