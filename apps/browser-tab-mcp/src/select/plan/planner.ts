/**
 * Pure transform planner — DSL Phase 3 PR-C.
 *
 * resolved tab selection + transform + snapshot → { effects, warnings,
 * riskClass } with the §7 edge-policy table enforced HERE, before anything
 * touches a browser:
 *
 *   emptySelection → error · non-tab kind → error · cross-domain live
 *   movement → error (uniformity, §24.5) · pinned members → error unless an
 *   explicit pinPolicy · destination anchor inside the selection → error ·
 *   group membership loss → warning (tabsOnly) · every clamp → warning.
 *
 * Policy errors carry a stable `code` property so callers and tests key on
 * the code, not the prose. The planner never invents a corrective action
 * (spec §14.3).
 *
 * Staged out of v1, recorded: `newWindow` destinations (the second relocate
 * of a block has no window identity to chain into at plan time — needs a
 * plan-local window token in the IR; `move_tab --new-window` already covers
 * the single-tab case), `pinPolicy:"unpin-first"` group recreation, and
 * group-by-predicate (needs group-membership effects).
 */

import type { Snapshot } from "@george43g/shared-types";
import type { BrowserRef } from "../browser-domain.js";
import { summarizeLiveMoveDomains } from "../domains.js";
import { type ActVerb, classifyRisk, type Effect, type RiskClass } from "./effects.js";
import { relocationsFor } from "./order.js";

export class PlanError extends Error {
  constructor(
    readonly code:
      | "empty_selection"
      | "non_tab_selection"
      | "cross_domain_live_move"
      | "pinned_without_policy"
      | "destination_in_selection"
      | "unknown_destination"
      | "unknown_member"
      | "invalid_transform",
    message: string,
  ) {
    super(message);
    this.name = "PlanError";
  }
}

export type Destination =
  | { kind: "slot"; windowId: string; at: number } // signed one-based gap, clamps
  | { kind: "anchor"; tabId: string; offset: 1 | -1 }; // after (+1) / before (-1)

export type Transform =
  | { kind: "move"; destination: Destination }
  | { kind: "setOrder"; windowId: string; tabs: string[] } // §25.3, unlisted stable
  | { kind: "reverse" } // §9.6 in-place, per window
  | { kind: "sort"; by: { field: string; direction?: "asc" | "desc" }[] } // stable, per window
  | { kind: "pack"; destination?: Destination } // §9.7; default: gap at first member
  | { kind: "act"; action: ActVerb; groupId?: string }; // Phase 5: verb over every member

export interface TransformPlan {
  effects: Effect[];
  warnings: string[];
  riskClass: RiskClass;
  /** Distinct live-move domains the plan operates in (always 1 in v1). */
  domains: string[];
}

interface WindowStrip {
  windowId: string;
  order: string[]; // tabIds, visual order
}

/** Snapshot lookup helpers, id-keyed. Pure over one snapshot. */
function stripsOf(snapshot: Snapshot): Map<string, WindowStrip> {
  const strips = new Map<string, WindowStrip>();
  for (const b of snapshot.browsers) {
    for (const w of b.windows) {
      strips.set(w.windowId, { windowId: w.windowId, order: w.tabs.map((t) => t.tabId) });
    }
  }
  return strips;
}

export function planTransform(
  refs: readonly BrowserRef[],
  transform: Transform,
  snapshot: Snapshot,
  opts: { pinPolicy?: "error" | "skip" } = {},
): TransformPlan {
  const warnings: string[] = [];

  if (refs.length === 0) {
    throw new PlanError(
      "empty_selection",
      "the selection is empty — a mutation over nothing is usually a selector mistake " +
        '(re-run select_tabs; pass emptySelection:"noOp" when empty is intended — not yet offered).',
    );
  }
  const nonTab = refs.find((r) => r.kind !== "tab");
  if (nonTab) {
    throw new PlanError(
      "non_tab_selection",
      `the selection contains a ${nonTab.kind} node — transforms act on tabs; ` +
        `project structural nodes through "members" first.`,
    );
  }
  const tabs = refs as Extract<BrowserRef, { kind: "tab" }>[];

  // Both guards below exist for RELOCATION and only for relocation. An `act`
  // moves nothing: muting a selection that spans Chrome and Safari is a
  // perfectly ordinary request, and unpinning one that contains pinned tabs is
  // the entire point. Applying the relocation guards to acts would ship a
  // language able to SELECT across browsers and refusing to ACT across them —
  // which is the shape of the gap this phase exists to close, reintroduced one
  // layer down. (Phase 5 PR-M.)
  const relocating = transform.kind !== "act";

  // §24.5: ALL live relocation is blocked for a multi-domain selection.
  const domains = summarizeLiveMoveDomains(refs);
  if (relocating && !domains.uniform) {
    throw new PlanError(
      "cross_domain_live_move",
      `the selection spans ${domains.domains.length} live-move domain(s) with ` +
        `${domains.unknownCount} member(s) having none — live movement needs one shared ` +
        `domain. Narrow the selection, or use copy/cut for cross-domain transfer (Phase 3 F/G).`,
    );
  }

  // Pinned members change index-space semantics and browsers clamp around
  // them; silent policy invention is forbidden (§14.3).
  let working = tabs;
  const pinned = relocating ? tabs.filter((t) => t.tab.pinned === true) : [];
  if (pinned.length > 0) {
    if (opts.pinPolicy === "skip") {
      working = tabs.filter((t) => t.tab.pinned !== true);
      warnings.push(
        `pinPolicy:"skip" dropped ${pinned.length} pinned tab(s): ` +
          pinned.map((t) => t.tab.tabId).join(", "),
      );
      if (working.length === 0) {
        throw new PlanError(
          "empty_selection",
          'every selected tab is pinned and pinPolicy:"skip" dropped them all — nothing to plan.',
        );
      }
    } else {
      throw new PlanError(
        "pinned_without_policy",
        `${pinned.length} selected tab(s) are pinned (${pinned
          .map((t) => t.tab.tabId)
          .join(", ")}) — pass pinPolicy:"skip" to leave them, or unpin first. ` +
          `No default is applied on your behalf.`,
      );
    }
  }

  const grouped = working.filter((t) => t.tab.groupId !== undefined);
  if (grouped.length > 0 && (transform.kind === "move" || transform.kind === "pack")) {
    const groups = [...new Set(grouped.map((t) => t.tab.groupId as string))];
    warnings.push(
      `moving ${grouped.length} grouped tab(s) leaves group(s) ${groups.join(", ")} behind ` +
        `(policy tabsOnly — group preservation is a later, explicit feature).`,
    );
  }

  const strips = stripsOf(snapshot);
  const selectedIds = new Set(working.map((t) => t.tab.tabId));
  const orderedIds = working.map((t) => t.tab.tabId);

  let effects: Effect[];
  switch (transform.kind) {
    case "move":
      effects = planLanding(transform.destination, orderedIds, selectedIds, strips, warnings);
      break;
    case "pack": {
      // Default destination: the gap at the FIRST selected tab (§9.7).
      const first = orderedIds[0] as string;
      const dest: Destination = transform.destination ?? {
        kind: "anchor",
        tabId: first,
        offset: -1,
      };
      // An anchor inside the selection is legal for pack's default only: the
      // landing computation excludes selected tabs from the survivor strip,
      // so anchor-on-first means "where the first member sat".
      effects = planLanding(dest, orderedIds, selectedIds, strips, warnings, {
        allowAnchorInSelection: transform.destination === undefined,
      });
      break;
    }
    case "setOrder": {
      const strip = strips.get(transform.windowId);
      if (!strip) {
        throw new PlanError(
          "unknown_destination",
          `window "${transform.windowId}" is not in the snapshot — re-run list_tabs.`,
        );
      }
      const missing = transform.tabs.filter((id) => !strip.order.includes(id));
      if (missing.length > 0) {
        throw new PlanError(
          "unknown_member",
          `setOrder names tab(s) not in window ${transform.windowId}: ${missing.join(", ")}.`,
        );
      }
      if (new Set(transform.tabs).size !== transform.tabs.length) {
        throw new PlanError("invalid_transform", "setOrder lists a tab more than once.");
      }
      // Listed tabs keep the SLOTS the listed set occupies, permuted to the
      // listed order; unlisted tabs stay put (§25.3 unlisted:"stable").
      const listed = new Set(transform.tabs);
      let k = 0;
      const desired = strip.order.map((id) =>
        listed.has(id) ? (transform.tabs[k++] as string) : id,
      );
      effects = relocationsFor(strip.order, desired, strip.windowId);
      break;
    }
    case "act": {
      // One effect per member, in selection order. No landing computation, no
      // strip arithmetic: an act changes a tab's own state, not where it sits.
      // Risk is the VERB's (ACT_VERB_RISK), so a discard plan comes back
      // riskClass "destructive" and apply_tab_layout refuses it by the same
      // gate that refuses a cut.
      if (transform.action === "group" && transform.groupId === undefined) {
        const windows = new Set(working.map((t) => t.window.windowId));
        if (windows.size > 1) {
          throw new PlanError(
            "invalid_transform",
            `action "group" with no groupId creates ONE group, but the selection spans ` +
              `${windows.size} windows — a Chrome group cannot straddle windows. Narrow the ` +
              `selection to one window, or pass an existing groupId.`,
          );
        }
      }
      effects = working.map((t) => ({
        kind: "act" as const,
        tabId: t.tab.tabId,
        action: transform.action,
        ...(transform.groupId !== undefined ? { groupId: transform.groupId } : {}),
      }));
      break;
    }
    case "reverse":
    case "sort": {
      // In-place permutation per window (§9.6): selected occupants permute
      // across their own occupied slots; everything else stays.
      effects = [];
      const byWindow = new Map<string, Extract<BrowserRef, { kind: "tab" }>[]>();
      for (const t of working) {
        const arr = byWindow.get(t.window.windowId) ?? [];
        arr.push(t);
        byWindow.set(t.window.windowId, arr);
      }
      if (byWindow.size > 1) {
        warnings.push(
          `${transform.kind} applies per window: the selection spans ${byWindow.size} windows ` +
            `and each window's members permute within their own slots.`,
        );
      }
      for (const [windowId, members] of byWindow) {
        const strip = strips.get(windowId);
        if (!strip) continue;
        const inStripOrder = strip.order.filter((id) => members.some((m) => m.tab.tabId === id));
        let occupants: string[];
        if (transform.kind === "reverse") {
          occupants = [...inStripOrder].reverse();
        } else {
          const refOf = new Map(members.map((m) => [m.tab.tabId, m]));
          occupants = [...inStripOrder].sort((a, b) => {
            for (const key of transform.by) {
              const av = fieldOf(refOf.get(a), key.field);
              const bv = fieldOf(refOf.get(b), key.field);
              const cmp = compareValues(av, bv);
              if (cmp !== 0) return key.direction === "desc" ? -cmp : cmp;
            }
            return 0; // stable: Array.sort is stable in V8/Node
          });
        }
        let k = 0;
        const memberSet = new Set(inStripOrder);
        const desired = strip.order.map((id) =>
          memberSet.has(id) ? (occupants[k++] as string) : id,
        );
        effects.push(...relocationsFor(strip.order, desired, windowId));
      }
      break;
    }
    default:
      throw new PlanError("invalid_transform", "unknown transform kind");
  }

  if (effects.length === 0) {
    warnings.push("the selection already satisfies this transform — the plan is a no-op.");
  }
  return { effects, warnings, riskClass: classifyRisk(effects), domains: domains.domains };
}

/** Block landing at a destination gap (§5.4 semantics). */
function planLanding(
  dest: Destination,
  orderedIds: readonly string[],
  selectedIds: ReadonlySet<string>,
  strips: Map<string, WindowStrip>,
  warnings: string[],
  opts: { allowAnchorInSelection?: boolean } = {},
): Effect[] {
  let destWindowId: string;
  let afterId: string | null;

  if (dest.kind === "anchor") {
    if (selectedIds.has(dest.tabId) && !opts.allowAnchorInSelection) {
      throw new PlanError(
        "destination_in_selection",
        `destination anchor ${dest.tabId} is inside the selection being moved — ` +
          `its post-move position is ambiguous. Anchor to a tab outside the selection.`,
      );
    }
    let anchorWindow: string | undefined;
    for (const strip of strips.values()) {
      if (strip.order.includes(dest.tabId)) {
        anchorWindow = strip.windowId;
        break;
      }
    }
    if (anchorWindow === undefined) {
      throw new PlanError(
        "unknown_destination",
        `anchor tab "${dest.tabId}" is not in the snapshot — re-run list_tabs.`,
      );
    }
    destWindowId = anchorWindow;
    const survivors = (strips.get(anchorWindow) as WindowStrip).order.filter(
      (id) => !selectedIds.has(id),
    );
    if (dest.offset === 1) {
      // After the anchor — or, if the anchor itself is selected (pack
      // default), after the anchor's nearest surviving LEFT neighbour.
      afterId = survivors.includes(dest.tabId)
        ? dest.tabId
        : survivorLeftOf(strips.get(anchorWindow) as WindowStrip, dest.tabId, selectedIds);
    } else {
      afterId = survivorLeftOf(strips.get(anchorWindow) as WindowStrip, dest.tabId, selectedIds);
    }
  } else {
    const strip = strips.get(dest.windowId);
    if (!strip) {
      throw new PlanError(
        "unknown_destination",
        `window "${dest.windowId}" is not in the snapshot — re-run list_tabs.`,
      );
    }
    destWindowId = dest.windowId;
    // §5.4: the gap resolves against the pre-op snapshot MINUS the selection;
    // signed one-based slots over the survivor strip, clamping.
    const survivors = strip.order.filter((id) => !selectedIds.has(id));
    const slots = survivors.length + 1;
    if (dest.at === 0) {
      throw new PlanError("invalid_transform", "slot 0 is invalid — slots are one-based signed.");
    }
    let slot = dest.at > 0 ? dest.at : slots + dest.at + 1;
    if (slot < 1 || slot > slots) {
      warnings.push(`slot ${dest.at} is out of range for ${slots} gap(s) — clamped.`);
      slot = Math.min(Math.max(slot, 1), slots);
    }
    afterId = slot === 1 ? null : (survivors[slot - 2] as string);
  }

  // Desired arrangement of the destination window: survivors with the block
  // inserted after `afterId`; members from other windows are incoming.
  const destStrip = strips.get(destWindowId) as WindowStrip;
  const survivors = destStrip.order.filter((id) => !selectedIds.has(id));
  const insertAt = afterId === null ? 0 : survivors.indexOf(afterId) + 1;
  const desired = [...survivors.slice(0, insertAt), ...orderedIds, ...survivors.slice(insertAt)];
  return relocationsFor(destStrip.order, desired, destWindowId);
}

function survivorLeftOf(
  strip: WindowStrip,
  tabId: string,
  selectedIds: ReadonlySet<string>,
): string | null {
  const idx = strip.order.indexOf(tabId);
  for (let i = idx - 1; i >= 0; i--) {
    const id = strip.order[i] as string;
    if (!selectedIds.has(id)) return id;
  }
  return null;
}

function fieldOf(ref: Extract<BrowserRef, { kind: "tab" }> | undefined, field: string): unknown {
  if (!ref) return undefined;
  switch (field) {
    case "title":
      return ref.tab.title;
    case "url":
      return ref.tab.url;
    case "index":
      return ref.tab.index;
    case "lastAccessed":
      return ref.tab.lastAccessed;
    case "host":
      try {
        return new URL(ref.tab.url).hostname;
      } catch {
        return undefined;
      }
    default:
      return undefined;
  }
}

function compareValues(a: unknown, b: unknown): number {
  // Undefined sorts LAST regardless of direction — unknown never wins a race.
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b));
}
