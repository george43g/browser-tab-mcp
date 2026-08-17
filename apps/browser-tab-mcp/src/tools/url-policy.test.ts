/**
 * The URL allowlist. `open_tab` / `open_window` / `tab_action navigate` all
 * declared `url: z.string()` while documenting "http(s) URL", so any string
 * reached a real browser — including the two that change what this tool IS:
 * `javascript:` runs script in the page's origin, and `file:` puts a local file
 * somewhere `get_page` will read it back.
 *
 * The caller is usually a model that has just read untrusted web content, so
 * these are the tests that keep a prompt injection from becoming an exfil.
 */

import { afterEach, describe, expect, it } from "vitest";
import { allowedSchemes, checkUrl } from "./url-policy.js";

const KEY = "BROWSER_TAB_ALLOW_URL_SCHEMES";
const saved = process.env[KEY];

afterEach(() => {
  if (saved === undefined) delete process.env[KEY];
  else process.env[KEY] = saved;
});

describe("dangerous schemes are refused by default", () => {
  for (const url of [
    "javascript:alert(1)",
    "JavaScript:alert(1)",
    "file:///etc/passwd",
    "data:text/html,<script>fetch('http://evil')</script>",
    "blob:https://example.com/abc",
    "vbscript:msgbox(1)",
    "filesystem:https://example.com/temporary/x",
    "ws://example.com",
  ]) {
    it(`rejects ${url}`, () => {
      expect(checkUrl(url).ok).toBe(false);
    });
  }

  // `new URL()` lowercases the protocol, so case folding is not a bypass —
  // this asserts that property rather than assuming it.
  it("normalizes scheme case, so JaVaScRiPt: is the same rejection", () => {
    expect(checkUrl("JaVaScRiPt:alert(1)").reason).toContain('"javascript:"');
  });

  it("names the scheme and the escape hatch, so the caller can act", () => {
    const reason = checkUrl("file:///etc/passwd").reason ?? "";
    expect(reason).toContain("file:");
    expect(reason).toContain("BROWSER_TAB_ALLOW_URL_SCHEMES");
  });
});

describe("what the tool documents keeps working", () => {
  for (const url of [
    "https://example.com/a/b?c=1#d",
    "http://localhost:3000/",
    "about:blank",
    // The README's own extension-reload instructions send you here.
    "chrome://extensions",
    "chrome-extension://abcdefghijklmnop/options.html",
    "brave://settings",
  ]) {
    it(`accepts ${url}`, () => {
      expect(checkUrl(url).ok).toBe(true);
    });
  }
});

describe("relative URLs are refused rather than guessed at", () => {
  // Resolving these needs a base. Inventing one for a string that came from a
  // model is exactly the kind of helpfulness that turns into a bypass.
  for (const url of ["/etc/passwd", "example.com", "", "   "]) {
    it(`rejects ${JSON.stringify(url)}`, () => {
      expect(checkUrl(url).ok).toBe(false);
      expect(checkUrl(url).reason).toContain("absolute URL");
    });
  }
});

describe("the opt-in widens the list, explicitly", () => {
  it("accepts a scheme once it is named", () => {
    expect(checkUrl("file:///etc/hosts").ok).toBe(false);
    process.env[KEY] = "file";
    expect(checkUrl("file:///etc/hosts").ok).toBe(true);
  });

  it("normalizes entries — `file`, `file:` and ` FILE: ` all mean the same", () => {
    for (const raw of ["file", "file:", " FILE: "]) {
      process.env[KEY] = raw;
      expect(allowedSchemes(), `for ${JSON.stringify(raw)}`).toContain("file:");
    }
  });

  it("accepts a comma-separated list and ignores empty entries", () => {
    process.env[KEY] = "file, ,data,";
    expect(allowedSchemes()).toContain("file:");
    expect(allowedSchemes()).toContain("data:");
    expect(allowedSchemes()).not.toContain(":");
  });

  it("an empty value changes nothing", () => {
    process.env[KEY] = "";
    expect(checkUrl("javascript:alert(1)").ok).toBe(false);
  });
});
