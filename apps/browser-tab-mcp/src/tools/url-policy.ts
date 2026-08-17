/**
 * Which URLs this tool is willing to hand a real browser.
 *
 * WHY THIS EXISTS. `open_tab`, `open_window` and `tab_action navigate` all
 * declared `url: z.string()` while *documenting* "http(s) URL". Any string got
 * through — including the two that turn a tab-management tool into something
 * else entirely:
 *
 *   javascript:…  runs attacker-chosen script in the page's own origin
 *   file:///…     opens a local file, which `get_page` will then read back
 *
 * That matters here more than in a normal CLI, because the caller is usually a
 * model that has just been reading untrusted web content. A prompt injection
 * that reaches `open_tab` should not be able to exfiltrate cookies or read
 * `~/.ssh/id_rsa`; with a bare `z.string()` it could do both.
 *
 * WHY AN ALLOWLIST, NOT A DENYLIST. A denylist has to enumerate every dangerous
 * scheme correctly, forever. An allowlist fails closed on the ones nobody
 * thought of. The default list is what the tool documents plus the
 * browser-internal pages it already tells you to visit (`chrome://extensions`
 * is in the README's own reload instructions) and its own settings page.
 *
 * WHY POLICY LIVES IN THE APP, NOT shared-types. shared-types is also bundled
 * into the browser extension, where `process.env` does not exist; and the
 * schemas there describe the WIRE SHAPE, which is genuinely "a string". What
 * this process is willing to act on is a local decision, so it belongs here.
 */

import { envStr } from "@george43g/robustness/env";
import { z } from "zod";

/**
 * Schemes accepted with no configuration.
 *
 * `about:` covers `about:blank`. The vendor schemes cover the browser-internal
 * pages this tool already points users at; `chrome-extension:` covers the
 * connector's own options page.
 */
export const DEFAULT_URL_SCHEMES = [
  "http:",
  "https:",
  "about:",
  "chrome:",
  "chrome-extension:",
  "chromium:",
  "brave:",
  "edge:",
  "vivaldi:",
  "opera:",
] as const;

/**
 * Extra schemes the operator has explicitly opted into, e.g.
 * `BROWSER_TAB_ALLOW_URL_SCHEMES=file,data`. Read per call so a test (or a
 * single invocation) can widen it without a restart. Entries are normalized —
 * `file`, `file:` and `FILE:` all mean the same thing.
 */
function extraSchemes(): string[] {
  const raw = envStr("BROWSER_TAB_ALLOW_URL_SCHEMES", "");
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase().replace(/:$/, ""))
    .filter((s) => s.length > 0)
    .map((s) => `${s}:`);
}

/** Every scheme currently acceptable, defaults plus opt-ins. */
export function allowedSchemes(): string[] {
  return [...DEFAULT_URL_SCHEMES, ...extraSchemes()];
}

export interface UrlVerdict {
  ok: boolean;
  /** Present when `ok` is false — safe to show the caller. */
  reason?: string;
}

/**
 * Judge one URL. Relative URLs are rejected outright: `new URL()` needs a base
 * to resolve them, and guessing a base for a string that came from a model is
 * exactly the kind of helpfulness that becomes a bypass.
 */
export function checkUrl(raw: string): UrlVerdict {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return {
      ok: false,
      reason: `"${raw}" is not an absolute URL. Pass a full URL including its scheme, e.g. https://example.com.`,
    };
  }
  // `URL` lowercases the protocol, so no case-folding bypass here.
  const scheme = parsed.protocol;
  if (allowedSchemes().includes(scheme)) return { ok: true };
  return {
    ok: false,
    reason:
      `Scheme "${scheme}" is not allowed. Permitted: ${allowedSchemes().join(" ")}. ` +
      `Add more with BROWSER_TAB_ALLOW_URL_SCHEMES (comma-separated) if you intend it — ` +
      `note that javascript: runs script in the page's origin and file: exposes local files ` +
      `to get_page.`,
  };
}

/** Zod string that only accepts a URL this process is willing to open. */
export function navigableUrl(description: string): z.ZodType<string> {
  return z
    .string()
    .superRefine((value, ctx) => {
      const verdict = checkUrl(value);
      if (!verdict.ok) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: verdict.reason ?? "Rejected URL." });
      }
    })
    .describe(description);
}
