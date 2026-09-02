/**
 * Browser effect IR — DSL Phase 3 PR-C
 * (docs/agent-handoff/plans/2026-09-02-dsl-phase-3-planner.md).
 *
 * Bounded, browser-specific primitives (spec §25.1). Deliberately NOT a
 * universal transformation hierarchy — tmux/terminal domains get their own
 * effects when they exist (architecture doc §5, anti-abstraction rules).
 *
 * Position is expressed by NEIGHBOR IDENTITY, never by concrete index:
 * spec §14.2 — "the planner works with stable identities and gaps;
 * translation occurs only in the executor". `after: null` means the start of
 * the parent's tab strip. A block landing is expressed by chaining: the
 * first moved tab is `after` the anchor neighbour, the second is `after` the
 * first moved tab, and so on — stable under live index drift between plan
 * and apply.
 *
 * v1 deviation from the phase plan, recorded: `setOrder` is a TRANSFORM
 * (compiled to relocates at plan time via the LIS diff in order.ts), not an
 * IR member — concrete relocates make dry-run counts honest and keep the
 * PR-E executor total (no effect it must reject as "not yet lowered"). It
 * joins the IR if/when the end-state solver needs the compact form.
 */

import type { BrowserId } from "@george43g/shared-types";

/** Live reparent/reorder of one existing tab. State-preserving by contract. */
export interface RelocateEffect {
  kind: "relocate";
  tabId: string;
  targetWindowId: string;
  /** Land immediately after this tab (null = front of the strip). */
  after: string | null;
  /** Split into a brand-new window instead (targetWindowId/after ignored). */
  newWindow?: boolean;
}

/** Reconstruct a tab from transferable descriptors (spec §9.3). Loads the page. */
export interface CreateReconstructedEffect {
  kind: "createReconstructed";
  /** Correlates this creation with its source and any closeVerified effect. */
  sourceTabId: string;
  url: string;
  targetWindowId?: string;
  newWindow?: boolean;
  browser?: BrowserId;
  pinned?: boolean;
}

/** Close a source tab ONLY after its reconstruction verified (spec §9.4). */
export interface CloseVerifiedEffect {
  kind: "closeVerified";
  tabId: string;
  /** The creation this closure is contingent on (sourceTabId linkage). */
  contingentOn: string;
}

/** Group/pin metadata on an existing node. */
export interface SetMetadataEffect {
  kind: "setMetadata";
  target: { groupId: string };
  title?: string;
  color?: string;
}

/** One bounded capability-declared tab action fanned by the caller. */
export interface ActEffect {
  kind: "act";
  tabId: string;
  action: "pin" | "unpin" | "mute" | "unmute";
}

export type Effect =
  | RelocateEffect
  | CreateReconstructedEffect
  | CloseVerifiedEffect
  | SetMetadataEffect
  | ActEffect;

export type RiskClass = "live-layout" | "additive" | "destructive";

/**
 * Risk from effects, not intent (spec §26.2): anything that closes is
 * destructive; anything that creates without closing is additive; pure
 * relocation/metadata/act is live layout. `apply_tab_layout` accepts ONLY
 * "live-layout" — this classifier is the gate that keeps destructive work
 * out of the safe-looking tool.
 */
export function classifyRisk(effects: readonly Effect[]): RiskClass {
  let additive = false;
  for (const e of effects) {
    if (e.kind === "closeVerified") return "destructive";
    if (e.kind === "createReconstructed") additive = true;
  }
  return additive ? "additive" : "live-layout";
}
