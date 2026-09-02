/**
 * apply_tab_layout — the live-layout executor (DSL Phase 3 PR-E). Applies
 * ONLY a current plan_tab_change plan whose riskClass is "live-layout":
 * never copy, cut, or close — those get their own explicitly-riskier tools
 * (spec §26.2). Multi-effect application is NOT transactional; the result
 * reports per-effect outcomes, the ACTUAL final arrangement, and any
 * residual difference (spec §15).
 */

import type { ToolDefinition } from "@george43g/mcp-kit";
import { z } from "zod";
import { applyTabLayout } from "../client/tabs-service.js";

export const ApplyTabLayoutInputSchema = z.object({
  planId: z
    .string()
    .describe(
      "A current plan_tab_change planId with riskClass live-layout. Stale plans (state " +
        "changed since planning) are refused — re-plan and apply fresh.",
    ),
});

export const ApplyTabLayoutOutputSchema = z.object({
  status: z
    .enum(["success", "partial", "failed"])
    .describe("partial = some effects applied, or the outcome differs from the plan."),
  planId: z.string(),
  results: z.array(
    z
      .object({
        status: z.enum(["applied", "failed", "skipped"]),
        error: z.string().optional(),
      })
      .passthrough(),
  ),
  actual: z
    .record(z.array(z.string()))
    .describe("windowId → actual final tab order for every affected window."),
  residual: z.array(
    z.object({
      windowId: z.string(),
      expected: z.array(z.string()),
      actual: z.array(z.string()),
    }),
  ),
  snapshotTokenBefore: z.string().optional(),
  snapshotTokenAfter: z.string().optional(),
});

export const applyTabLayoutTool: ToolDefinition<
  typeof ApplyTabLayoutInputSchema,
  typeof ApplyTabLayoutOutputSchema
> = {
  name: "apply_tab_layout",
  description:
    "Apply a live-layout plan from plan_tab_change: state-preserving tab moves only — never " +
    "reloads, closures, or reconstructions (those are copy_tabs/cut_tabs). Not transactional: " +
    "the first failed effect aborts the rest, and the result reports per-effect outcomes, the " +
    "actual final window arrangements, and any residual difference from the plan. Stale plans " +
    "are refused. Requires the daemon and the browser extension.",
  input: ApplyTabLayoutInputSchema,
  output: ApplyTabLayoutOutputSchema,
  annotations: {
    title: "Apply tab layout",
    readOnlyHint: false,
    // Live moves preserve tab identity and page state by contract; nothing
    // is closed or reloaded, so nothing user-owned can be irreversibly lost.
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  timeoutMs: 30_000,
  handler: async (input, signal) => {
    if (signal?.aborted) throw new Error("Cancelled by client");
    return (await applyTabLayout({ planId: input.planId })) as z.infer<
      typeof ApplyTabLayoutOutputSchema
    >;
  },
};
