/**
 * cgWindowId correlation — the yabai join key.
 *
 * yabai window ids ARE CGWindowIDs, so enriching each browser window with
 * its CGWindowID lets wm-stack join on id instead of title matching.
 *
 * Matching: group CG windows by the browser's pid, then match AppleScript
 * window bounds against CG bounds within a small tolerance. Ambiguity
 * (two same-bounds windows) yields cgWindowId: null — never a guess.
 *
 * Bounds alone are NOT enough under a tiling WM: yabai gives every same-space
 * window of an app the identical frame, so every window of a multi-window
 * browser is ambiguous and the join dies in exactly the setup it exists for.
 * So ambiguity falls through to a **title tiebreaker** — yabai reports a
 * distinct title per window, and the snapshot's window title is a substring of
 * it (Chrome appends " - Google Chrome - <profile>", Safari prepends
 * "<profile> — "). The tiebreaker still returns null unless exactly one
 * candidate matches, and drops any id claimed by two windows. Titles come from
 * yabai rather than kCGWindowName because the latter needs Screen Recording
 * consent.
 *
 * The opposite failure also exists: bounds matching **zero** candidates,
 * because a source reported `y` relative to the window's display while `x`
 * stayed global (Safari's WebExtension API does exactly this — see
 * `offsetCandidates`). So the tiers are: exact bounds → bounds shifted by each
 * display origin → title alone. A window resolved by either fallback also
 * has its `bounds` corrected from the matched CG frame, so a display-local
 * source stops lying to consumers downstream.
 *
 * Source chain:
 *   1. rust-accel native listCgWindows()   (CGWindowListCopyWindowInfo)
 *   2. `yabai -m query --windows`          (yabai already knows ids+frames)
 *   3. none — cgWindowId stays null
 *
 * yabai window ids ARE CGWindowIDs, so a yabai-sourced title map keys
 * correctly against native-sourced CG windows — that's what lets tier 1 borrow
 * titles from tier 2 without giving up native z-order.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { warn } from "@george43g/robustness";
import type { BrowserId, CgWindowInfo, Snapshot } from "@george43g/shared-types";
import { tryLoadNative } from "../native-bridge.js";
import { listDisplays } from "./displays.js";

const execFileAsync = promisify(execFile);

const BOUNDS_TOLERANCE_PX = 2;

export type CorrelationTier = "native" | "yabai" | "none";

export function nativeCgAvailable(): boolean {
  const native = tryLoadNative();
  if (!native || typeof native.listCgWindows !== "function") return false;
  try {
    native.listCgWindows();
    return true;
  } catch {
    return false;
  }
}

/** Env override (BROWSER_TAB_YABAI_BIN) exists so tests can shim the binary. */
function yabaiCandidates(): string[] {
  const override = process.env.BROWSER_TAB_YABAI_BIN;
  if (override) return [override];
  return ["/opt/homebrew/bin/yabai", "/usr/local/bin/yabai", "yabai"];
}

interface YabaiWindow {
  id: number;
  pid: number;
  title?: string;
  frame: { x: number; y: number; w: number; h: number };
}

/** Window id → window title, for the ambiguity tiebreaker. */
export type TitleMap = ReadonlyMap<number, string>;

interface YabaiRead {
  windows: CgWindowInfo[];
  titles: TitleMap;
}

async function readYabaiWindows(signal?: AbortSignal): Promise<YabaiRead | null> {
  for (const bin of yabaiCandidates()) {
    try {
      const { stdout } = await execFileAsync(bin, ["-m", "query", "--windows"], {
        timeout: 2_000,
        maxBuffer: 8 * 1024 * 1024,
        ...(signal ? { signal } : {}),
      });
      const rows = JSON.parse(stdout) as YabaiWindow[];
      const titles = new Map<number, string>();
      for (const r of rows) {
        if (typeof r.title === "string" && r.title.length > 0) titles.set(r.id, r.title);
      }
      return {
        windows: rows.map((r) => ({
          windowId: r.id,
          ownerPid: r.pid,
          x: r.frame.x,
          y: r.frame.y,
          w: r.frame.w,
          h: r.frame.h,
          layer: 0,
        })),
        titles,
      };
    } catch {
      // try next candidate
    }
  }
  return null;
}

/** Which correlation source is currently usable (for doctor / daemon_status). */
export async function correlationTier(): Promise<CorrelationTier> {
  if (nativeCgAvailable()) return "native";
  if ((await readYabaiWindows()) !== null) return "yabai";
  return "none";
}

interface CgRead {
  windows: CgWindowInfo[];
  /** True when the source reports front-to-back z-order (native CG list). */
  zOrdered: boolean;
  /** Present only when the source carries titles (yabai). */
  titles?: TitleMap;
}

async function readCgWindows(signal?: AbortSignal): Promise<CgRead | null> {
  const native = tryLoadNative();
  if (native && typeof native.listCgWindows === "function") {
    try {
      // No titles: kCGWindowName needs Screen Recording consent, so the native
      // tier borrows them from yabai on demand (see enrichWithCgWindowIds).
      return { windows: native.listCgWindows(), zOrdered: true };
    } catch (err) {
      warn("cg_native_failed", { message: (err as Error).message });
    }
  }
  const yabai = await readYabaiWindows(signal);
  return yabai ? { windows: yabai.windows, zOrdered: false, titles: yabai.titles } : null;
}

function boundsMatch(
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean {
  return (
    Math.abs(a.x - b.x) <= BOUNDS_TOLERANCE_PX &&
    Math.abs(a.y - b.y) <= BOUNDS_TOLERANCE_PX &&
    Math.abs(a.w - b.w) <= BOUNDS_TOLERANCE_PX &&
    Math.abs(a.h - b.h) <= BOUNDS_TOLERANCE_PX
  );
}

/** Case/whitespace-insensitive form used for both sides of a title compare. */
function normalizeTitle(raw: string): string {
  return raw.normalize("NFC").replace(/\s+/gu, " ").trim().toLowerCase();
}

/**
 * Strictest relationship first. The window manager's title contains the
 * snapshot's (Chrome suffixes " - Google Chrome - <profile>", Safari prefixes
 * "<profile> — "), so boundary matches are the real signal and bare
 * containment is a last resort. A tier that matches two candidates falls
 * through — but every looser tier is a superset, so that ends in null.
 */
const TITLE_TIERS: ((want: string, have: string) => boolean)[] = [
  (want, have) => have === want,
  (want, have) => have.startsWith(want) || have.endsWith(want),
  (want, have) => have.includes(want) || want.includes(have),
];

/**
 * Distinct global y-origins of the active displays, used to undo a
 * display-local `y`. Passed in (not read here) so the matching core stays pure.
 */
export type DisplayOrigins = readonly number[];

/**
 * Some sources report `y` relative to the window's display while `x` stays
 * global, so bounds matching finds NOTHING rather than too much.
 *
 * Verified on this stack (2026-08-10): Safari's WebExtension `windows` API
 * reported y=50 for a window CoreGraphics, yabai and AppleScript all place at
 * y=299, on a display whose global origin is y=249 — and the same window on the
 * main display (origin y=0) reported y=50 against a true y=50. Two displays,
 * delta always exactly the display origin.
 *
 * So retry each display origin as a candidate offset. A hit is corroborated by
 * CG rather than guessed, which also makes the matched frame the truth — see
 * `correlateSnapshot`, which adopts it.
 */
function offsetCandidates(
  bounds: { x: number; y: number; w: number; h: number },
  candidates: CgWindowInfo[],
  origins: DisplayOrigins,
): CgWindowInfo[] {
  const hits: CgWindowInfo[] = [];
  for (const dy of origins) {
    if (dy === 0) continue; // identical to the direct match already tried
    const shifted = { ...bounds, y: bounds.y + dy };
    for (const cg of candidates) {
      if (boundsMatch(shifted, cg) && !hits.includes(cg)) hits.push(cg);
    }
  }
  return hits;
}

/** Exactly one candidate whose title relates to the window's, else null. */
function tiebreakByTitle(
  windowTitle: string,
  matches: CgWindowInfo[],
  titles: TitleMap | undefined,
): number | null {
  if (!titles) return null;
  const want = normalizeTitle(windowTitle);
  if (!want) return null;
  const named = matches
    .map((cg) => ({ windowId: cg.windowId, title: normalizeTitle(titles.get(cg.windowId) ?? "") }))
    .filter((c) => c.title.length > 0);
  for (const relates of TITLE_TIERS) {
    const hits = named.filter((c) => relates(want, c.title));
    const only = hits[0];
    if (hits.length === 1 && only !== undefined) return only.windowId;
  }
  return null;
}

/** Resolve a tiebreaker's id back to the candidate it names. */
function byId(windowId: number | null, pool: CgWindowInfo[]): CgWindowInfo | null {
  if (windowId === null) return null;
  return pool.find((cg) => cg.windowId === windowId) ?? null;
}

/**
 * The tier that actually resolved a pick, for diagnostics tallying:
 * "exact"/"shifted" mean a single candidate matched geometry alone (no
 * tiebreak needed); "title" means a title tiebreak was needed to pick a
 * winner out of an ambiguous set — regardless of which geometry tier
 * produced that ambiguous set; "none" means the tiebreak (or the absence of
 * a title map) left it unresolved.
 */
type PickTier = "exact" | "shifted" | "title" | "none";

interface PickResult {
  cg: CgWindowInfo | null;
  tier: PickTier;
}

/**
 * The CG window for one browser window. Three tiers, strictest first:
 * exact bounds → the same bounds shifted by a display origin → title alone.
 * Each tier tiebreaks by title when it matches more than one candidate, and
 * anything still ambiguous ends as null — never a guess.
 */
function pickCgWindow(
  bounds: { x: number; y: number; w: number; h: number },
  windowTitle: string,
  candidates: CgWindowInfo[],
  titles: TitleMap | undefined,
  origins: DisplayOrigins,
): PickResult {
  const exact = candidates.filter((cg) => boundsMatch(bounds, cg));
  const onlyExact = exact[0];
  if (exact.length === 1 && onlyExact !== undefined) return { cg: onlyExact, tier: "exact" };
  if (exact.length > 1) {
    const resolved = byId(tiebreakByTitle(windowTitle, exact, titles), exact);
    return resolved ? { cg: resolved, tier: "title" } : { cg: null, tier: "none" };
  }

  const shifted = offsetCandidates(bounds, candidates, origins);
  const onlyShifted = shifted[0];
  if (shifted.length === 1 && onlyShifted !== undefined)
    return { cg: onlyShifted, tier: "shifted" };
  if (shifted.length > 1) {
    const resolved = byId(tiebreakByTitle(windowTitle, shifted, titles), shifted);
    return resolved ? { cg: resolved, tier: "title" } : { cg: null, tier: "none" };
  }

  // No geometry agreed at all — the title is the only evidence left. Still
  // requires a unique match, so a nameless or duplicated title stays null.
  const resolved = byId(tiebreakByTitle(windowTitle, candidates, titles), candidates);
  return resolved ? { cg: resolved, tier: "title" } : { cg: null, tier: "none" };
}

/**
 * True when bounds alone can't resolve every window — either two CG windows
 * share a window's frame (tiled) or none matches it (display-local `y`). Both
 * are cases a title map can rescue, so this is the gate for paying to fetch
 * one. Cheap enough to run before that.
 */
export function needsTitleTiebreak(snapshot: Snapshot, cgWindows: CgWindowInfo[]): boolean {
  for (const b of snapshot.browsers) {
    if (b.pid === null || b.windows.length === 0) continue;
    const candidates = cgWindows.filter((cg) => cg.ownerPid === b.pid && cg.layer === 0);
    if (candidates.length === 0) continue;
    for (const w of b.windows) {
      const bounds = w.bounds;
      if (!bounds) continue;
      if (candidates.filter((cg) => boundsMatch(bounds, cg)).length !== 1) return true;
    }
  }
  return false;
}

/**
 * The frontmost browser, derived from front-to-back CG window order: the
 * first layer-0 window owned by a running browser wins. Only meaningful
 * when the CG list is z-ordered (native tier) — undefined otherwise.
 */
export function frontmostBrowser(
  snapshot: Snapshot,
  cgWindows: CgWindowInfo[],
): BrowserId | undefined {
  const pidToBrowser = new Map<number, BrowserId>();
  for (const b of snapshot.browsers) {
    if (b.pid !== null && b.running) pidToBrowser.set(b.pid, b.browser);
  }
  for (const cg of cgWindows) {
    if (cg.layer !== 0) continue;
    const browser = pidToBrowser.get(cg.ownerPid);
    if (browser) return browser;
  }
  return undefined;
}

/**
 * Per-browser tally of how `correlateSnapshot` resolved each window, for
 * root-causing cgWindowId oscillation without adding logging/I/O to the
 * matching core itself. Purely additive bookkeeping written into the
 * caller-supplied `diag` out-param — never read back, never affects the
 * returned Snapshot.
 */
export interface BrowserCorrelationDiag {
  browser: string;
  /** Windows with bounds that entered correlation (candidates.length > 0). */
  windows: number;
  /** CG windows for this pid at layer 0. */
  candidates: number;
  /** Resolved by a single unique exact-bounds match — no tiebreak needed. */
  exact: number;
  /** Resolved by a single unique display-origin-shifted match — no tiebreak needed. */
  shifted: number;
  /** Resolved by a title tiebreak (whichever geometry tier produced the ambiguous set). */
  titleOnly: number;
  /** Ended null: tiebreak was needed but couldn't uniquely resolve (tier exhaustion). */
  nulled: number;
  /** Dropped because two windows both claimed the same CG id — counted separately from `nulled`. */
  claimCollisions: number;
}

export interface CorrelationDiag {
  browsers: BrowserCorrelationDiag[];
  titlesAvailable: boolean;
  originsCount: number;
}

function emptyBrowserDiag(browser: string): BrowserCorrelationDiag {
  return {
    browser,
    windows: 0,
    candidates: 0,
    exact: 0,
    shifted: 0,
    titleOnly: 0,
    nulled: 0,
    claimCollisions: 0,
  };
}

/**
 * Pure matching core (unit-testable): for each browser window, find the CG
 * window owned by the browser's pid whose bounds match within tolerance.
 * Multiple candidates fall through to the title tiebreaker when `titles` is
 * supplied, else → null. No pid → null. A CG window claimed by two browser
 * windows was never decisive evidence, so both sides go back to null. When
 * `zOrdered`, also stamps `focusedBrowser` from the CG z-order.
 *
 * `diag`, when supplied, is populated with a pure tally of tier resolution —
 * it never changes the returned Snapshot (see the diagnostics test asserting
 * output identity with/without it).
 */
export function correlateSnapshot(
  snapshot: Snapshot,
  cgWindows: CgWindowInfo[],
  zOrdered = false,
  titles?: TitleMap,
  displayOrigins: DisplayOrigins = [],
  diag?: CorrelationDiag,
): Snapshot {
  if (diag) {
    diag.titlesAvailable = titles !== undefined;
    diag.originsCount = displayOrigins.length;
  }
  const correlated: Snapshot = {
    ...snapshot,
    browsers: snapshot.browsers.map((b) => {
      const browserDiag = diag ? emptyBrowserDiag(b.browser) : undefined;
      if (browserDiag) diag?.browsers.push(browserDiag);
      if (b.pid === null || b.windows.length === 0) return b;
      const candidates = cgWindows.filter((cg) => cg.ownerPid === b.pid && cg.layer === 0);
      if (browserDiag) browserDiag.candidates = candidates.length;
      if (candidates.length === 0) return b;
      // undefined = window has no bounds, leave its id untouched.
      const picks = b.windows.map((w) =>
        w.bounds ? pickCgWindow(w.bounds, w.title, candidates, titles, displayOrigins) : undefined,
      );
      if (browserDiag) browserDiag.windows = picks.filter((p) => p !== undefined).length;
      const claims = new Map<number, number>();
      for (const pick of picks) {
        if (pick !== undefined && pick.cg !== null)
          claims.set(pick.cg.windowId, (claims.get(pick.cg.windowId) ?? 0) + 1);
      }
      return {
        ...b,
        windows: b.windows.map((w, i) => {
          const pick = picks[i];
          if (pick === undefined) return w;
          const { cg, tier } = pick;
          if (cg === null) {
            if (browserDiag) browserDiag.nulled++;
            return { ...w, cgWindowId: null };
          }
          if (claims.get(cg.windowId) !== 1) {
            if (browserDiag) browserDiag.claimCollisions++;
            return { ...w, cgWindowId: null };
          }
          if (browserDiag) {
            if (tier === "exact") browserDiag.exact++;
            else if (tier === "shifted") browserDiag.shifted++;
            else if (tier === "title") browserDiag.titleOnly++;
          }
          // CG corroborated this window, so its frame is the truth. Adopting it
          // repairs a source that reported display-local coordinates; for a
          // source that was already right this is a no-op within tolerance.
          const bounds =
            w.bounds && !boundsMatch(w.bounds, cg) ? { x: cg.x, y: cg.y, w: cg.w, h: cg.h } : null;
          return { ...w, cgWindowId: cg.windowId, ...(bounds ? { bounds } : {}) };
        }),
      };
    }),
  };
  if (!zOrdered) return correlated;
  const focused = frontmostBrowser(correlated, cgWindows);
  return focused ? { ...correlated, focusedBrowser: focused } : correlated;
}

/** Enrich a snapshot with cgWindowIds. Failures degrade to null ids, never throw. */
export async function enrichWithCgWindowIds(
  snapshot: Snapshot,
  signal?: AbortSignal,
): Promise<Snapshot> {
  // Fixture snapshots have no real CG windows to join — skip correlation so
  // tests never spawn `yabai`/native (deterministic + fast, no timing flake).
  if (process.env.BROWSER_TAB_FAKE_ADAPTER === "1") return snapshot;
  try {
    const cg = await readCgWindows(signal);
    if (!cg) return snapshot;
    // The native tier has no titles of its own. Borrow yabai's, but only once
    // bounds have actually failed to resolve something — a clean poll must not
    // pay for a subprocess it cannot learn anything from.
    let titles = cg.titles;
    if (!titles && needsTitleTiebreak(snapshot, cg.windows)) {
      titles = (await readYabaiWindows(signal))?.titles;
    }
    const origins = [...new Set(listDisplays().map((d) => d.y))];
    return correlateSnapshot(snapshot, cg.windows, cg.zOrdered, titles, origins);
  } catch (err) {
    warn("cg_correlation_failed", { message: (err as Error).message });
    return snapshot;
  }
}
