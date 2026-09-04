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

/**
 * Verbs an `act` transform can fan over a selection, and what each one COSTS.
 *
 * Phase 5 PR-M. Until 2026-09-04 this effect existed with four verbs and NO
 * producer anywhere in `src/` — a declared capability the planner could not
 * emit (completeness review, gap G2). Wiring it made one thing load-bearing
 * that had not been before: **risk can no longer be read off the effect kind
 * alone.** Pinning a tab and discarding it are the same `kind: "act"` and are
 * not remotely the same act — `discard` and `reload` throw away in-page state
 * that nothing can reconstruct, which is exactly why `tab_action` carries
 * `destructiveHint: true`. So the risk of an act is a property of its VERB,
 * and this table is where that lives.
 *
 * The consequence to protect: `apply_tab_layout` accepts only "live-layout"
 * (`daemon/apply.ts`), so a verb landing in this table as live-layout becomes
 * reachable through a tool that asks for no confirmation. `effects.test.ts`
 * enumerates the table against this map so a verb added without a considered
 * entry fails rather than defaulting into the safe-looking door.
 */
export const ACT_VERB_RISK = {
  pin: "live-layout",
  unpin: "live-layout",
  mute: "live-layout",
  unmute: "live-layout",
  group: "live-layout",
  ungroup: "live-layout",
  discard: "destructive",
  reload: "destructive",
} as const satisfies Record<string, RiskClass>;

export type ActVerb = keyof typeof ACT_VERB_RISK;
export const ACT_VERBS = Object.keys(ACT_VERB_RISK) as ActVerb[];

/** One bounded capability-declared tab action fanned by the caller. */
export interface ActEffect {
  kind: "act";
  tabId: string;
  action: ActVerb;
  /** group: the group to join. Omitted = create a new group from the members. */
  groupId?: string;
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
    // An act is as risky as its verb, never as its kind — see ACT_VERB_RISK.
    if (e.kind === "act" && ACT_VERB_RISK[e.action] === "destructive") return "destructive";
    if (e.kind === "createReconstructed") additive = true;
  }
  return additive ? "additive" : "live-layout";
}
