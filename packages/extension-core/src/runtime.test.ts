/**
 * runtime shim unit test — the `api` Proxy resolution (browser > chrome, throw
 * when neither) and `detectBrowserName` UA sniffing.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { api, detectBrowserName } from "./runtime.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api proxy resolution", () => {
  it("throws when no extension API is present", () => {
    vi.stubGlobal("browser", undefined);
    vi.stubGlobal("chrome", undefined);
    expect(() => api.runtime).toThrow(/WebExtension API unavailable/);
  });

  it("prefers globalThis.browser over globalThis.chrome", () => {
    vi.stubGlobal("browser", { runtime: { id: "browser" } });
    vi.stubGlobal("chrome", { runtime: { id: "chrome" } });
    expect((api.runtime as unknown as { id: string }).id).toBe("browser");
  });

  it("falls back to globalThis.chrome when browser is absent", () => {
    vi.stubGlobal("browser", undefined);
    vi.stubGlobal("chrome", { runtime: { id: "chrome" } });
    expect((api.runtime as unknown as { id: string }).id).toBe("chrome");
  });
});

describe("detectBrowserName", () => {
  it("returns safari for a Safari UA", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 Version/17.0 Safari/605.1.15" });
    expect(detectBrowserName()).toBe("safari");
  });

  it("returns chrome for a Chrome UA (Chrome UAs also contain 'Safari')", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 Chrome/120.0 Safari/537.36" });
    expect(detectBrowserName()).toBe("chrome");
  });

  it("returns chrome when navigator is absent", () => {
    vi.stubGlobal("navigator", undefined);
    expect(detectBrowserName()).toBe("chrome");
  });
});
