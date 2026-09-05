/**
 * apply_destructive_plan — the other door (Phase 5 PR-N).
 *
 * `apply_tab_layout` is annotated `destructiveHint: false` and applies only
 * live-layout plans. A flag that flipped it into a destructive mode would make
 * that annotation false exactly when a caller most needs it to be true, so the
 * risk lives in the TOOL NAME instead (spec §26.2, risk-coherent tools) and
 * the gate is the same `confirmDestruction` contract `cut_tabs` already uses.
 *
 * Today that means `discard` and `reload` over a selection: both throw away
 * in-page state — scroll position, form contents, the live DOM — which no
 * record can restore, so the operation journal records what was LOST rather
 * than a restore path that does not exist.
 */

import type { ToolDefinition } from "@george43g/mcp-kit";
import { z } from "zod";
import { applyDestructivePlan } from "../client/tabs-service.js";
import { ApplyTabLayoutOutputSchema } from "./apply-tab-layout.js";

export const ApplyDestructivePlanInputSchema = z.object({
  planId: z
    .string()
    .describe(
      'A current plan_tab_change planId with riskClass "destructive" — an act plan whose verb ' +
        "is discard or reload. A live-layout plan is refused here and belongs to apply_tab_layout.",
    ),
  confirmDestruction: z
    .literal(true)
    .describe(
      "Must be exactly true. In-page state (scroll, unsaved form input, the live DOM) is " +
        "destroyed for every member and cannot be restored.",
    ),
});

export const applyDestructivePlanTool: ToolDefinition<
  typeof ApplyDestructivePlanInputSchema,
  typeof ApplyTabLayoutOutputSchema
> = {
  name: "apply_destructive_plan",
  description:
    "Apply a DESTRUCTIVE plan from plan_tab_change — an act whose verb throws away in-page " +
    "state (discard, reload) across every member of a selection. Requires " +
    "confirmDestruction:true. Stale plans are refused outright and are never re-planned on " +
    "your behalf: a destructive plan derived against a world that has since changed is a " +
    "decision for a person, not a retry policy. Reconstructive transfer (which closes sources " +
    "after verifying replacements) is copy_tabs/cut_tabs, not this. Requires the daemon and " +
    "the browser extension.",
  input: ApplyDestructivePlanInputSchema,
  output: ApplyTabLayoutOutputSchema,
  annotations: {
    title: "Apply destructive plan",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  timeoutMs: 30_000,
  handler: async (input, signal) => {
    if (signal?.aborted) throw new Error("Cancelled by client");
    return (await applyDestructivePlan({
      planId: input.planId,
      confirmDestruction: input.confirmDestruction,
    })) as z.infer<typeof ApplyTabLayoutOutputSchema>;
  },
};
