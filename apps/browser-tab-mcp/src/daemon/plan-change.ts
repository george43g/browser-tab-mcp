/**
 * `plan_tab_change` daemon orchestration — DSL Phase 3 PR-D.
 *
 * Read-only planning: selector-or-selectionId + ONE transform → a
 * materialized, snapshot-bound plan. Nothing mutates; `apply_tab_layout`
 * (PR-E) is the only consumer of the planId and accepts only
 * riskClass:"live-layout".
 *
 * The two selection paths deliberately share one resolution boundary:
 * an inline selector resolves fresh HERE (same snapshot as the plan); a
 * `selectionId` must be non-stale — its keys were resolved against the SAME
 * snapshotToken this plan binds to, so re-resolution is a no-op by
 * construction and the keys map back through byKey. A stale selection is a
 * §14.1 conflict:"error", never a silent re-resolve.
 */

import { assertValid, parseSelector, resolveSelector } from "@george43g/control-language";
import { z } from "zod";
import { type BrowserRef, makeBrowserDomain } from "../select/browser-domain.js";
import { ACT_VERBS, type ActVerb, type Effect } from "../select/plan/effects.js";
import { type EndStateInput, type PreparedRequest, planEndState } from "../select/plan/endstate.js";
import { planTransform, type Transform } from "../select/plan/planner.js";
import { mapTemporalProvider } from "../select/temporal.js";
import type { JournalStore } from "./journal.js";
import type { MaterializedPlan, PlanStore } from "./plans.js";
import type { SelectionStore } from "./selections.js";
import type { StateStore } from "./state.js";

export const DestinationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("slot").describe("A gap in a window's tab strip."),
      windowId: z.string().describe("Destination window handle."),
      at: z
        .number()
        .int()
        .describe(
          "Signed one-based gap: 1 = before the first tab, -1 = after the last. 0 invalid.",
        ),
    })
    .strict(),
  z
    .object({
      kind: z.literal("anchor").describe("A gap adjacent to an existing tab."),
      tabId: z.string().describe("Anchor tab handle (must be outside the selection)."),
      offset: z
        .union([z.literal(1), z.literal(-1)])
        .describe("1 = the gap after the anchor, -1 = the gap before it."),
    })
    .strict(),
]);

export const TransformSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("move").describe("Move the selection as a contiguous block to a gap."),
      destination: DestinationSchema,
    })
    .strict(),
  z
    .object({
      kind: z
        .literal("setOrder")
        .describe("Permute the listed tabs across their own slots (§25.3)."),
      windowId: z.string().describe("The window whose strip is being ordered."),
      tabs: z.array(z.string()).min(1).describe("Desired relative order; unlisted tabs stay put."),
    })
    .strict(),
  z.object({ kind: z.literal("reverse").describe("In-place reverse per window.") }).strict(),
  z
    .object({
      kind: z.literal("sort").describe("Stable in-place sort per window."),
      by: z
        .array(
          z
            .object({
              field: z
                .enum(["title", "url", "host", "index", "lastAccessed"])
                .describe("Sort key."),
              direction: z.enum(["asc", "desc"]).default("asc"),
            })
            .strict(),
        )
        .min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("pack").describe("Gather the selection contiguously (§9.7)."),
      destination: DestinationSchema.optional().describe(
        "Landing gap; omitted = where the first selected tab sits.",
      ),
    })
    .strict(),
  z
    .object({
      kind: z
        .literal("act")
        .describe("Apply one verb to every member of the selection (Phase 5, §26.2 risk)."),
      action: z
        .enum(ACT_VERBS as [ActVerb, ...ActVerb[]])
        .describe(
          "pin/unpin · mute/unmute · group/ungroup are live-layout and applyable. " +
            "discard/reload throw away in-page state, so the plan comes back riskClass " +
            "destructive and apply_tab_layout refuses it.",
        ),
      groupId: z
        .string()
        .optional()
        .describe('action "group": the group to join. Omitted = a new group from the members.'),
    })
    .strict(),
]);

export const EndStateSchema = z
  .object({
    strict: z
      .boolean()
      .optional()
      .describe(
        "true = the listed tabs must be exactly each window's final content (§11.1); " +
          "unlisted survivors are validation errors, never implied closes.",
      ),
    windows: z
      .array(
        z
          .object({
            windowId: z.string().describe("An EXISTING window handle."),
            tabs: z
              .array(
                z.union([
                  z.string().describe("Tab handle — implies move within one live-move domain."),
                  z
                    .object({
                      tabId: z.string(),
                      transport: z
                        .enum(["copy", "cut", "auto"])
                        .optional()
                        .describe(
                          'Required across a live-move-domain boundary. "auto" = move within ' +
                            "a domain, copy across — never cut (§11.2).",
                        ),
                    })
                    .strict(),
                ]),
              )
              .min(1)
              .describe("Desired leading run, in order; unlisted tabs keep relative order after."),
          })
          .strict(),
      )
      .min(1),
  })
  .strict();

export const PlanTabChangeParamsSchema = z
  .object({
    selector: z.unknown().optional().describe("Inline selector AST (control-language)."),
    selectionId: z
      .string()
      .optional()
      .describe("A select_tabs materialized selection — must still be current."),
    transform: z
      .unknown()
      .optional()
      .describe("One transform (validated against TransformSchema)."),
    endState: z
      .unknown()
      .optional()
      .describe(
        "Declarative §11 end state (validated against EndStateSchema) — INSTEAD of a selection+transform.",
      ),
    pinPolicy: z
      .enum(["skip"])
      .optional()
      .describe('How to treat pinned members: "skip" drops them (reported). Default: error.'),
  })
  .refine(
    (v) =>
      v.endState !== undefined
        ? v.selector === undefined && v.selectionId === undefined && v.transform === undefined
        : (v.selector === undefined) !== (v.selectionId === undefined) && v.transform !== undefined,
    {
      message: "provide (exactly one of selector | selectionId) + transform, OR endState alone",
    },
  );

export interface PlanTabChangeResult {
  planId: string;
  riskClass: MaterializedPlan["riskClass"];
  effects: Effect[];
  effectCount: number;
  warnings: string[];
  selectionKeys: string[];
  snapshotToken?: string | undefined;
  revision?: number | undefined;
  /** Present when planned from an endState: the reconstructive halves as
   * prepared requests, and the §11.5 live/copy/cut counts. */
  endState?:
    | {
        additive: PreparedRequest[];
        destructive: PreparedRequest[];
        counts: { live: number; copy: number; cut: number };
      }
    | undefined;
}

export interface PlanChangeDeps {
  store: StateStore;
  journal: JournalStore;
  selections: SelectionStore;
  plans: PlanStore;
}

export function planTabChange(
  params: Record<string, unknown>,
  deps: PlanChangeDeps,
): PlanTabChangeResult {
  const input = PlanTabChangeParamsSchema.parse(params);

  const snapshot = deps.store.getSnapshot();
  const temporal = deps.journal.temporalSnapshot();
  const domain = makeBrowserDomain(snapshot, {
    temporal: mapTemporalProvider(temporal.focused, temporal.navigated),
    focusedWindowHint: deps.journal.windowMru(1)[0]?.windowId,
  });

  if (input.endState !== undefined) {
    const endState = EndStateSchema.parse(input.endState) as EndStateInput;
    const plan = planEndState(endState, snapshot, domain);
    // Only the LIVE half materializes as an applyable plan; the prepared
    // copy/cut requests ride the result for the caller to submit
    // deliberately (§26.2 risk coherence — the solver's own header).
    // No transform is stored: an end-state plan is not replannable by
    // ids+transform; conflict:"replan" on it is refused with a pointer here.
    const liveTabIds = [
      ...new Set(plan.effects.flatMap((e) => (e.kind === "relocate" ? [e.tabId] : []))),
    ];
    const record = deps.plans.materialize({
      riskClass: "live-layout",
      effects: plan.effects,
      warnings: plan.warnings,
      selectionKeys: liveTabIds,
      snapshotToken: snapshot.snapshotToken ?? "",
    });
    return {
      planId: record.planId,
      riskClass: record.riskClass,
      effects: record.effects,
      effectCount: record.effects.length,
      warnings: record.warnings,
      selectionKeys: record.selectionKeys,
      snapshotToken: snapshot.snapshotToken,
      revision: snapshot.revision,
      endState: {
        additive: plan.additive,
        destructive: plan.destructive,
        counts: plan.counts,
      },
    };
  }
  const transform = TransformSchema.parse(input.transform) as Transform;

  let refs: BrowserRef[];
  const warnings: string[] = [];
  if (input.selector !== undefined) {
    const selector = parseSelector(input.selector);
    assertValid(selector, domain);
    const resolved = resolveSelector(selector, domain);
    refs = resolved.occurrences.map((o) => o.entity);
    warnings.push(...resolved.warnings);
  } else {
    const rec = deps.selections.get(input.selectionId as string, snapshot.snapshotToken);
    if (rec === undefined) {
      throw new Error(
        `selection "${input.selectionId}" is unknown or expired — selections are ` +
          `snapshot-bound and short-lived; re-run select_tabs.`,
      );
    }
    if (rec.stale) {
      throw new Error(
        `selection "${input.selectionId}" was resolved against a different snapshot ` +
          `(state has changed since) — re-run select_tabs and plan again.`,
      );
    }
    refs = [];
    for (const key of rec.keys) {
      const ref = domain.byKey(key);
      if (ref === undefined) {
        // Token-equal yet missing should be impossible; treat as conflict.
        throw new Error(
          `selection member "${key}" is no longer in the snapshot — re-run select_tabs.`,
        );
      }
      refs.push(ref);
    }
  }

  const plan = planTransform(refs, transform, snapshot, {
    ...(input.pinPolicy !== undefined ? { pinPolicy: input.pinPolicy } : {}),
  });
  const record = deps.plans.materialize({
    riskClass: plan.riskClass,
    effects: plan.effects,
    warnings: [...warnings, ...plan.warnings],
    selectionKeys: refs.map((r) => keyOf(r)),
    snapshotToken: snapshot.snapshotToken ?? "",
    // Kept for conflict:"replan" (PR-I): the same intent, re-planned over the
    // stored identity keys against a fresh snapshot.
    transform,
    ...(input.pinPolicy !== undefined ? { pinPolicy: input.pinPolicy } : {}),
  });

  return {
    planId: record.planId,
    riskClass: record.riskClass,
    effects: record.effects,
    effectCount: record.effects.length,
    warnings: record.warnings,
    selectionKeys: record.selectionKeys,
    snapshotToken: snapshot.snapshotToken,
    revision: snapshot.revision,
  };
}

function keyOf(r: BrowserRef): string {
  switch (r.kind) {
    case "browser":
      return r.browser.browser;
    case "window":
      return r.window.windowId;
    case "group":
      return r.group.groupId;
    case "tab":
      return r.tab.tabId;
  }
}
