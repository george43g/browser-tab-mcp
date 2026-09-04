/**
 * plan_tab_change — read-only planning, the second tool of the five-tool
 * surface (DSL Phase 3 PR-D). Computes and materializes a plan; applies
 * nothing. `apply_tab_layout` (PR-E) is the only consumer of the planId and
 * accepts only riskClass:"live-layout" — risk separation per spec §26.2.
 */

import { SelectorSchema } from "@george43g/control-language";
import type { ToolDefinition } from "@george43g/mcp-kit";
import { z } from "zod";
import { planTabChange } from "../client/tabs-service.js";
import { DestinationSchema, EndStateSchema, TransformSchema } from "../daemon/plan-change.js";

export const PlanTabChangeInputSchema = z
  .object({
    selector: SelectorSchema.optional().describe(
      "Inline selector AST (same language as select_tabs). Provide this OR selectionId.",
    ),
    selectionId: z
      .string()
      .optional()
      .describe(
        "A current select_tabs selectionId — stale selections are refused, not re-resolved.",
      ),
    transform: TransformSchema.optional().describe(
      'One transform: move (block, to a slot/anchor gap) · setOrder ("these tabs in this ' +
        'relative order, unlisted stay put") · reverse · sort · pack · act (apply one verb — ' +
        "pin/unpin, mute/unmute, group/ungroup, discard, reload — to every member). One " +
        "transform per call; composition lives in the selector. Omit when passing endState.",
    ),
    endState: EndStateSchema.optional().describe(
      "Declarative §11 end state INSTEAD of selection+transform: name windows and the leading " +
        "run of tabs each should hold. Same-domain entries move live; cross-domain entries " +
        'must declare transport ("auto" = move within a domain, copy across — never cut). ' +
        "The live half becomes the returned plan; copy/cut halves come back as prepared " +
        "requests to submit deliberately.",
    ),
    pinPolicy: z
      .enum(["skip"])
      .optional()
      .describe('Pinned members: "skip" drops them (reported per tab). Omitted = error on pinned.'),
  })
  .refine(
    (v) =>
      v.endState !== undefined
        ? v.selector === undefined && v.selectionId === undefined && v.transform === undefined
        : (v.selector === undefined) !== (v.selectionId === undefined) && v.transform !== undefined,
    { message: "provide (exactly one of selector | selectionId) + transform, OR endState alone" },
  );

const EffectViewSchema = z
  .object({
    kind: z.string(),
  })
  .passthrough();

export const PlanTabChangeOutputSchema = z.object({
  planId: z.string().describe("Short-lived, snapshot-bound plan id — pass to apply_tab_layout."),
  riskClass: z
    .enum(["live-layout", "additive", "destructive"])
    .describe("What applying would do; apply_tab_layout accepts only live-layout."),
  effects: z.array(EffectViewSchema).describe("Ordered primitive effects (dry-run detail)."),
  effectCount: z.number().int(),
  warnings: z.array(z.string()),
  selectionKeys: z.array(z.string()),
  snapshotToken: z.string().optional(),
  revision: z.number().int().optional(),
  endState: z
    .object({
      additive: z.array(z.object({ tool: z.literal("copy_tabs"), params: z.record(z.unknown()) })),
      destructive: z.array(
        z.object({ tool: z.literal("cut_tabs"), params: z.record(z.unknown()) }),
      ),
      counts: z.object({ live: z.number().int(), copy: z.number().int(), cut: z.number().int() }),
    })
    .optional()
    .describe(
      "End-state planning only: the reconstructive halves as prepared tool requests (cut " +
        "requests still require confirmDestruction when submitted) and live/copy/cut counts.",
    ),
});

export const planTabChangeTool: ToolDefinition<
  typeof PlanTabChangeInputSchema,
  typeof PlanTabChangeOutputSchema
> = {
  name: "plan_tab_change",
  description:
    "Plan ONE tab transform (move/setOrder/reverse/sort/pack/act) over a selection WITHOUT applying " +
    "it: returns the ordered primitive effects, warnings, risk class, and a short-lived planId " +
    "for apply_tab_layout. Policy violations (pinned members, cross-domain live movement, " +
    "destination inside the selection) fail HERE with stable codes, before any browser is " +
    "touched. Requires the daemon.",
  input: PlanTabChangeInputSchema,
  output: PlanTabChangeOutputSchema,
  annotations: {
    title: "Plan tab change",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  timeoutMs: 10_000,
  handler: async (input, signal) => {
    if (signal?.aborted) throw new Error("Cancelled by client");
    return (await planTabChange({
      ...(input.selector !== undefined ? { selector: input.selector } : {}),
      ...(input.selectionId !== undefined ? { selectionId: input.selectionId } : {}),
      ...(input.transform !== undefined ? { transform: input.transform } : {}),
      ...(input.endState !== undefined ? { endState: input.endState } : {}),
      ...(input.pinPolicy !== undefined ? { pinPolicy: input.pinPolicy } : {}),
    })) as z.infer<typeof PlanTabChangeOutputSchema>;
  },
};

// Re-exported for the CLI's --help examples and tests.
export { DestinationSchema };
