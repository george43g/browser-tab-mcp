/**
 * `sanitizeFavicon` — the single favicon transform both tab mappers share.
 * http(s) URLs pass; a data: URI is kept only under the byte cap (large inline
 * icons would bloat every debounced snapshot push); other schemes and junk are
 * dropped. Applied at the extension source so oversized icons never cross the WS.
 */

import { describe, expect, it } from "vitest";
import { FAVICON_MAX_BYTES, sanitizeFavicon } from "../src/index.js";

describe("sanitizeFavicon", () => {
  it("passes http(s) favicon URLs through unchanged", () => {
    expect(sanitizeFavicon("https://example.com/favicon.ico")).toBe(
      "https://example.com/favicon.ico",
    );
    expect(sanitizeFavicon("http://example.com/favicon.png")).toBe(
      "http://example.com/favicon.png",
    );
    expect(sanitizeFavicon("HTTPS://EXAMPLE.com/FavIcon.ico")).toBe(
      "HTTPS://EXAMPLE.com/FavIcon.ico",
    );
  });

  it("keeps a small inline data: favicon", () => {
    const small = `data:image/png;base64,${"A".repeat(64)}`;
    expect(sanitizeFavicon(small)).toBe(small);
  });

  it("drops a data: URI larger than the cap (the payload-budget guard)", () => {
    const big = `data:image/png;base64,${"A".repeat(FAVICON_MAX_BYTES)}`;
    expect(sanitizeFavicon(big)).toBeUndefined();
  });

  it("honors a caller-supplied cap", () => {
    const mid = `data:image/png;base64,${"A".repeat(200)}`;
    expect(sanitizeFavicon(mid, 64)).toBeUndefined();
    expect(sanitizeFavicon(mid, 10_000)).toBe(mid);
  });

  it("drops non-http/data schemes and junk", () => {
    expect(sanitizeFavicon("chrome://favicon/https://x")).toBeUndefined();
    expect(sanitizeFavicon("file:///tmp/icon.ico")).toBeUndefined();
    expect(sanitizeFavicon("javascript:alert(1)")).toBeUndefined();
    expect(sanitizeFavicon("")).toBeUndefined();
    expect(sanitizeFavicon("   ")).toBeUndefined();
    expect(sanitizeFavicon(undefined)).toBeUndefined();
    expect(sanitizeFavicon(42)).toBeUndefined();
  });

  it("trims surrounding whitespace before deciding", () => {
    expect(sanitizeFavicon("  https://example.com/f.ico  ")).toBe("https://example.com/f.ico");
  });
});
