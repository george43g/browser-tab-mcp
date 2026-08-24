/**
 * Detection engine — fans out across enabled browser adapters and
 * assembles the Snapshot contract shape.
 *
 * This is the daemon-less pathway (source: "osascript-direct"); the daemon
 * (M4) wraps the same adapters in a polling loop and serves merged
 * extension+AppleScript state.
 *
 * Env: BROWSER_TAB_BROWSERS — comma list of chrome|chromium|brave|edge|safari
 *      (default "chrome,chromium,brave,edge,safari").
 *      BROWSER_TAB_FAKE_ADAPTER=1 — fixture adapters for tests/stress.
 */

import { warn } from "@george43g/robustness";
import type { BrowserId, Snapshot } from "@george43g/shared-types";
import { hasAppleScript, hasWindowCorrelation } from "../platform.js";
import { CHROMIUM_SPECS, makeChromiumAdapter } from "./adapters/chromium.js";
import { fakeAdapterEnabled, makeFakeAdapter } from "./adapters/fake.js";
import { makeSafariAdapter, SAFARI_SPEC } from "./adapters/safari.js";
import type { AdapterSpec, BrowserAdapter } from "./adapters/types.js";
import { makeUnavailableAdapter } from "./adapters/unavailable.js";
import { applescriptCaps } from "./capabilities.js";
import { enrichWithCgWindowIds } from "./correlate.js";

/**
 * Browsers polled when `BROWSER_TAB_BROWSERS` is unset.
 *
 * `chromium` is included because it is a first-class `BrowserId` everywhere
 * else — schema, adapters, handle grammar, capabilities — and omitting it here
 * made it the one browser you had to name explicitly to see. A browser that is
 * not installed costs one cheap `probeProcess` and reports `running: false`,
 * so the default is inclusive rather than guessing what is on the machine.
 */
export const DEFAULT_BROWSERS: readonly BrowserId[] = [
  "chrome",
  "chromium",
  "brave",
  "edge",
  "safari",
];

const ALL_SPECS: readonly AdapterSpec[] = [...CHROMIUM_SPECS, SAFARI_SPEC];

export function enabledBrowsers(): BrowserId[] {
  const rawList = (process.env.BROWSER_TAB_BROWSERS ?? "").trim();
  if (!rawList) return [...DEFAULT_BROWSERS];
  const valid = new Set(ALL_SPECS.map((s) => s.browser));
  const picked = rawList
    .split(",")
    .map((b) => b.trim().toLowerCase())
    .filter((b): b is BrowserId => valid.has(b as BrowserId));
  return picked.length > 0 ? picked : [...DEFAULT_BROWSERS];
}

/**
 * Point the `chromium` browser id at a differently-NAMED Chromium build.
 *
 * WHY THIS EXISTS. The AppleScript adapter addresses a browser by APP NAME
 * (`tell application "Chromium"`), and Apple Events route by app identity —
 * not by pid, not by `--user-data-dir`. So a second instance of the same
 * bundle is not addressable separately, however isolated its profile is, and
 * "Chromium" is the only Chromium-family name this adapter knows besides the
 * three branded ones.
 *
 * That leaves several real builds unreachable: **Google Chrome for Testing**
 * (Google's own automation build, and what Playwright downloads), Thorium,
 * Ungoogled Chromium, and any locally-compiled Chromium. All of them speak the
 * identical scripting dictionary — `chromium.ts` derives every script body
 * from `spec.appName` and nothing else — so the only thing standing between
 * them and full support is the string.
 *
 * `processName` is set from the same value because a Chromium build's Mach-O
 * executable is named after its app; `bundleId` is deliberately NOT derived
 * and keeps reporting `org.chromium.Chromium`. Nothing keys off it — it is
 * informational in `BrowserState` (engine.ts:94), correlation joins on pid —
 * and inventing a second knob to make one cosmetic field accurate would cost
 * more than it is worth. If that ever stops being true, add the field, don't
 * guess it.
 *
 * Example: BROWSER_TAB_CHROMIUM_APP_NAME="Google Chrome for Testing"
 */
function retargetChromium(spec: AdapterSpec): AdapterSpec {
  if (spec.browser !== "chromium") return spec;
  const appName = process.env.BROWSER_TAB_CHROMIUM_APP_NAME?.trim();
  if (!appName) return spec;
  return { ...spec, appName, processName: appName };
}

export function specFor(browser: BrowserId): AdapterSpec {
  const spec = ALL_SPECS.find((s) => s.browser === browser);
  if (!spec) throw new Error(`Unknown browser "${browser}".`);
  return retargetChromium(spec);
}

export function makeAdapter(browser: BrowserId): BrowserAdapter {
  const spec = specFor(browser);
  if (fakeAdapterEnabled()) return makeFakeAdapter(spec);
  // Off macOS there is no `osascript` to talk to. Return an adapter that says
  // so rather than one that spawns a binary which is not there — see
  // adapters/unavailable.ts for why this is an adapter and not a branch.
  if (!hasAppleScript()) return makeUnavailableAdapter(spec);
  return spec.browser === "safari" ? makeSafariAdapter() : makeChromiumAdapter(spec);
}

export function makeAdapters(browsers: BrowserId[] = enabledBrowsers()): BrowserAdapter[] {
  return browsers.map((b) => makeAdapter(b));
}

/**
 * One-shot snapshot across the given browsers (default: enabled set).
 * A single misbehaving browser degrades to an `error` entry rather than
 * failing the whole scan.
 */
export async function readSnapshot(
  opts: { browsers?: BrowserId[]; signal?: AbortSignal } = {},
): Promise<Snapshot> {
  const adapters = makeAdapters(opts.browsers ?? enabledBrowsers());
  const states = await Promise.all(
    adapters.map(async (a) => {
      try {
        return await a.readState(opts.signal);
      } catch (err) {
        // readState already degrades internally; this is the belt for
        // unexpected throws (parser bugs, adapter regressions).
        warn(`adapter_read_failed: ${a.spec.browser}`, { message: (err as Error).message });
        return {
          browser: a.spec.browser,
          bundleId: a.spec.bundleId,
          pid: null,
          running: false,
          extensionConnected: false,
          dataSource: "applescript" as const,
          error: (err as Error).message,
          tabGroups: [],
          windows: [],
        };
      }
    }),
  );
  // AppleScript-sourced browsers carry the static capability map so consumers
  // see the same shape whether or not the extension is connected.
  const withCaps = states.map((s) => ({ ...s, capabilities: applescriptCaps(s.browser) }));
  const snapshot: Snapshot = {
    version: 2,
    generatedAt: Date.now(),
    source: "osascript-direct",
    browsers: withCaps,
  };
  // Fixture data has synthetic pids/bounds — correlation would be noise.
  if (fakeAdapterEnabled()) return snapshot;
  // The join key is a CGWindowID, which only CoreGraphics issues. Off macOS
  // `cgWindowId` stays null — absent, not wrong — and the wm-stack consumer
  // (yabai) is macOS-only anyway.
  if (!hasWindowCorrelation()) return snapshot;
  return enrichWithCgWindowIds(snapshot, opts.signal);
}
