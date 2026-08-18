/**
 * Which browsers get polled, and how the env override narrows that.
 *
 * `chromium` was a first-class `BrowserId` everywhere — schema, adapters,
 * handle grammar, capabilities — except in `DEFAULT_BROWSERS`, which made it
 * the one browser you had to name explicitly before it would appear. That is
 * the kind of inconsistency nothing fails on and everything trips over.
 */

import { BrowserIdSchema } from "@george43g/shared-types";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_BROWSERS, enabledBrowsers } from "./engine.js";

const saved = process.env.BROWSER_TAB_BROWSERS;
afterEach(() => {
  if (saved === undefined) delete process.env.BROWSER_TAB_BROWSERS;
  else process.env.BROWSER_TAB_BROWSERS = saved;
});

describe("enabledBrowsers", () => {
  it("defaults to EVERY browser the schema knows", () => {
    // Stated against the schema rather than a hardcoded list, so adding a
    // browser to `BrowserIdSchema` and forgetting the default turns this red.
    expect([...DEFAULT_BROWSERS].sort()).toEqual([...BrowserIdSchema.options].sort());
  });

  it("includes chromium by default", () => {
    delete process.env.BROWSER_TAB_BROWSERS;
    expect(enabledBrowsers()).toContain("chromium");
  });

  it("honours an explicit narrowing", () => {
    process.env.BROWSER_TAB_BROWSERS = "chrome,safari";
    expect(enabledBrowsers()).toEqual(["chrome", "safari"]);
  });

  it("ignores unknown names rather than polling something that cannot exist", () => {
    process.env.BROWSER_TAB_BROWSERS = "chrome,netscape";
    expect(enabledBrowsers()).toEqual(["chrome"]);
  });

  it("falls back to the defaults when the override names nothing valid", () => {
    // An all-invalid list is a typo, not a request for zero browsers — zero
    // would render an empty snapshot that looks like "no browsers running".
    process.env.BROWSER_TAB_BROWSERS = "netscape,lynx";
    expect(enabledBrowsers()).toEqual([...DEFAULT_BROWSERS]);
  });

  it("treats an empty override as unset", () => {
    process.env.BROWSER_TAB_BROWSERS = "   ";
    expect(enabledBrowsers()).toEqual([...DEFAULT_BROWSERS]);
  });
});
