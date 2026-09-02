/**
 * Declarative end-state solver — DSL staged-tail PR-J (spec §11).
 *
 * An end state names windows and the tabs they should hold; the solver
 * computes what has to happen, decomposed by RISK so §26.2's coherence
 * survives: live relocations compile to the same after-chained Effect IR
 * `apply_tab_layout` already executes, while cross-domain arrivals become
 * PREPARED REQUESTS for `copy_tabs`/`cut_tabs` — parameter payloads the
 * caller submits to those tools deliberately, cut still demanding its own
 * schema-level `confirmDestruction`. (Recorded deviation from the plan doc's
 * "planId input on copy/cut": prepared requests keep authorization exactly
 * where §16 put it, with zero new execution pathways.)
 *
 * v1 semantics, stated rather than implied:
 * - PARTIAL (default): a listed window's live-arriving tabs become its
 *   LEADING run, in listed order; its unlisted tabs keep their relative
 *   order after them (§11.1 "existing relative order and location where
 *   possible", made deterministic). STRICT: the listed tabs must be exactly
 *   the window's final content — an unlisted survivor in that window is a
 *   validation error, never an implied close.
 * - §11.2 transport policy verbatim: same live-move domain ⇒ move; across a
 *   boundary the entry MUST say transport "copy" or "cut"; "auto" resolves
 *   to move-within-domain or copy-across and NEVER cut. An EXPLICIT
 *   copy/cut is honored even within one domain (legal, just unusual).
 * - Windows must exist ("new" windows are staged out with the same reason as
 *   PR-C's newWindow destinations: no plan-local window token in the IR).
 * - Groups are not declarable in v1 (recorded staging); moving grouped tabs
 *   carries the standing tabsOnly warning.
 * - A listed PINNED tab that would live-move errors (§24.6 pin-region
 *   default); there is no pinPolicy in an end state — unpin first.
 * - Sub-plan ordering: live first, then additive, then destructive. The live
 *   desired strips therefore treat a cut/copy SOURCE as still present (its
 *   closure, if any, happens later and is cut_tabs' own verified business).
 *
 * Cost model (§11.4, in force order): 1. reconstruction only where declared
 * transport demands it; 2. within-window ordering via LIS so tabs already in
 * relative order do not move (relocationsFor); 3. no group tearing beyond
 * the declared moves; 4. one browser call per emitted relocate. Plans are
 * "minimal under this declared cost model" — never bare "minimal".
 */

import type { Snapshot } from "@george43g/shared-types";
import type { BrowserRef } from "../browser-domain.js";
import { liveMoveDomainId } from "../domains.js";
import type { Effect } from "./effects.js";
import { relocationsFor } from "./order.js";
import { PlanError } from "./planner.js";

export interface EndStateTabEntry {
  tabId: string;
  transport?: "copy" | "cut" | "auto" | undefined;
}

export interface EndStateWindow {
  windowId: string;
  tabs: Array<string | EndStateTabEntry>;
}

export interface EndStateInput {
  strict?: boolean | undefined;
  windows: EndStateWindow[];
}

export interface PreparedRequest {
  tool: "copy_tabs" | "cut_tabs";
  /** Submit these params to the named tool (cut additionally requires
   * confirmDestruction:true — deliberately NOT pre-filled here). */
  params: Record<string, unknown>;
}

export interface EndStatePlan {
  /** Live-layout half: after-chained relocates, apply_tab_layout-ready. */
  effects: Effect[];
  /** Additive half: copy_tabs requests, one per destination window. */
  additive: PreparedRequest[];
  /** Destructive half: cut_tabs requests, one per destination window. */
  destructive: PreparedRequest[];
  warnings: string[];
  counts: { live: number; copy: number; cut: number };
}

interface DomainLookup {
  byKey(key: string): BrowserRef | undefined;
}

type ArrivalKind = "live" | "copy" | "cut";

export function planEndState(
  input: EndStateInput,
  snapshot: Snapshot,
  domain: DomainLookup,
): EndStatePlan {
  const warnings: string[] = [];
  const strict = input.strict === true;

  // Current strips, id-keyed.
  const strips = new Map<string, string[]>();
  for (const b of snapshot.browsers) {
    for (const w of b.windows)
      strips.set(
        w.windowId,
        w.tabs.map((t) => t.tabId),
      );
  }

  // ---- Pre-pass: validate the declaration and classify every arrival ----
  const placed = new Map<string, string>(); // tabId → declared destination window
  const arrival = new Map<string, ArrivalKind>();

  for (const w of input.windows) {
    if (!strips.has(w.windowId)) {
      throw new PlanError(
        "unknown_destination",
        `end state names window "${w.windowId}", which is not in the snapshot — re-run list_tabs.`,
      );
    }
  }
  for (const w of input.windows) {
    const destDomain = domainOfWindow(domain, w.windowId, strips.get(w.windowId) as string[]);
    let liveIndex = 0;
    for (const entry of w.tabs) {
      const tabId = typeof entry === "string" ? entry : entry.tabId;
      const transport = typeof entry === "string" ? undefined : entry.transport;
      if (placed.has(tabId)) {
        throw new PlanError(
          "invalid_transform",
          `end state places tab ${tabId} in both ${placed.get(tabId)} and ${w.windowId} — ` +
            `one identity holds one place in the live tree.`,
        );
      }
      const ref = domain.byKey(tabId);
      if (ref === undefined || ref.kind !== "tab") {
        throw new PlanError(
          "unknown_member",
          `end state names tab "${tabId}", which is not in the snapshot — re-run list_tabs.`,
        );
      }
      const sourceDomain = liveMoveDomainId(ref);
      const sameDomain =
        sourceDomain !== null && destDomain !== null && sourceDomain === destDomain;

      let kind: ArrivalKind;
      if (transport === "copy") {
        kind = "copy";
      } else if (transport === "cut") {
        kind = "cut";
      } else if (sameDomain) {
        // undefined or "auto" within one domain ⇒ move (§11.2).
        kind = "live";
      } else if (transport === "auto") {
        // "auto" across a boundary ⇒ copy, NEVER cut (§11.2).
        kind = "copy";
      } else {
        throw new PlanError(
          "cross_domain_live_move",
          `tab ${tabId} (domain ${sourceDomain ?? "none"}) cannot live-move into window ` +
            `${w.windowId} (domain ${destDomain ?? "none"}) — declare transport:"copy" or ` +
            `"cut" for this entry ("auto" resolves to copy across a boundary, never cut).`,
        );
      }
      if (kind === "live") {
        if (
          ref.tab.pinned === true &&
          pinnedWouldMove(ref, w.windowId, liveIndex, strips.get(w.windowId) as string[])
        ) {
          throw new PlanError(
            "pinned_without_policy",
            `tab ${tabId} is pinned and the end state moves it — unpin first; ` +
              `end states apply no pin policy on your behalf (§24.6 default).`,
          );
        }
        liveIndex += 1;
      }
      placed.set(tabId, w.windowId);
      arrival.set(tabId, kind);
    }
  }

  // ---- Per-window compilation ----
  const effects: Effect[] = [];
  const additive: PreparedRequest[] = [];
  const destructive: PreparedRequest[] = [];
  let copyCount = 0;
  let cutCount = 0;

  for (const w of input.windows) {
    const current = strips.get(w.windowId) as string[];
    const liveArrivals: string[] = [];
    const copyArrivals: string[] = [];
    const cutArrivals: string[] = [];
    for (const entry of w.tabs) {
      const tabId = typeof entry === "string" ? entry : entry.tabId;
      const kind = arrival.get(tabId) as ArrivalKind;
      if (kind === "live") liveArrivals.push(tabId);
      else if (kind === "copy") copyArrivals.push(tabId);
      else cutArrivals.push(tabId);
    }
    copyCount += copyArrivals.length;
    cutCount += cutArrivals.length;

    // relocationsFor's contract: every current occupant appears in desired —
    // a tab leaves a window only by relocating INTO another one, so a live
    // DEPARTURE keeps its slot here (in `rest`, current relative order) and
    // is pulled out by the destination window's own arrival effect. Copy
    // sources stay by definition; cut sources are closed later by cut_tabs.
    const liveSet = new Set(liveArrivals);
    const rest = current.filter((id) => !liveSet.has(id));
    if (strict) {
      // What will REMAIN here after every sub-plan runs: unlisted occupants
      // that are not departing (live) and not being cut away.
      const remaining = rest.filter((id) => {
        const to = placed.get(id);
        if (to === undefined || to === w.windowId) return true;
        return arrival.get(id) === "copy";
      });
      if (remaining.length > 0) {
        throw new PlanError(
          "invalid_transform",
          `strict end state: window ${w.windowId} still holds unlisted tab(s) ` +
            `${remaining.join(", ")} — a strict layout must cover the window completely ` +
            `(closing is never implied; close explicitly first).`,
        );
      }
    }
    const desired = [...liveArrivals, ...rest];
    effects.push(...relocationsFor(current, desired, w.windowId));

    if (copyArrivals.length > 0) {
      additive.push({
        tool: "copy_tabs",
        params: {
          selector: { kind: "ids", ids: copyArrivals },
          destination: { kind: "window", windowId: w.windowId },
        },
      });
    }
    if (cutArrivals.length > 0) {
      destructive.push({
        tool: "cut_tabs",
        params: {
          selector: { kind: "ids", ids: cutArrivals },
          destination: { kind: "window", windowId: w.windowId },
        },
      });
      warnings.push(
        `window ${w.windowId}: ${cutArrivals.length} entr(y/ies) declare transport:"cut" — ` +
          `submitting that request CLOSES the sources; cut_tabs will demand ` +
          `confirmDestruction:true.`,
      );
    }
    const grouped = liveArrivals.filter((id) => {
      const r = domain.byKey(id);
      return r?.kind === "tab" && r.tab.groupId !== undefined;
    });
    if (grouped.length > 0) {
      warnings.push(
        `window ${w.windowId}: ${grouped.length} live arrival(s) are grouped — moves are ` +
          `tabsOnly (standing policy); group membership is not recreated.`,
      );
    }
  }

  if (effects.length === 0 && additive.length === 0 && destructive.length === 0) {
    warnings.push("the layout already holds — the end state is a no-op.");
  }
  return {
    effects,
    additive,
    destructive,
    warnings,
    counts: { live: effects.length, copy: copyCount, cut: cutCount },
  };
}

/** The live-move domain a window belongs to, via any of its current tabs
 * (falling back to the window ref itself for an empty window). */
function domainOfWindow(
  domain: DomainLookup,
  windowId: string,
  currentTabs: readonly string[],
): string | null {
  for (const id of currentTabs) {
    const r = domain.byKey(id);
    if (r?.kind === "tab" && r.window.windowId === windowId) return liveMoveDomainId(r);
  }
  const w = domain.byKey(windowId);
  return w !== undefined ? liveMoveDomainId(w) : null;
}

/** A pinned live arrival is unmoved only when it already sits exactly where
 * the leading run puts it (`liveIndex` = its position among the window's
 * live arrivals). Conservative: any doubt counts as a move. */
function pinnedWouldMove(
  ref: Extract<BrowserRef, { kind: "tab" }>,
  destWindowId: string,
  liveIndex: number,
  current: readonly string[],
): boolean {
  if (ref.window.windowId !== destWindowId) return true;
  return current[liveIndex] !== ref.tab.tabId;
}
