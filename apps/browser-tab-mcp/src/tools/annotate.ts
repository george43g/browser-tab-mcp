/**
 * annotate — a tiny URL-keyed note cache in the daemon so a consumer can
 * stash its OWN summaries/observations for a page in one place. Pass `note`
 * to set it, omit to read. The tool is the cache substrate, never the
 * intelligence — no AI runs here.
 */

import type { ToolDefinition } from "@george43g/mcp-kit";
import { AnnotateInputSchema, AnnotateOutputSchema } from "@george43g/shared-types";
import { annotate } from "../client/tabs-service.js";

export const annotateTool: ToolDefinition<typeof AnnotateInputSchema, typeof AnnotateOutputSchema> =
  {
    name: "annotate",
    description:
      "Read or write a URL-keyed note in the daemon's small annotation store — a place to cache a " +
      "consumer's own summary/observations for a page. Pass `note` to set it; omit `note` to read the " +
      "existing one. Returns whether a note already existed and when it was last set. Daemon-only.",
    input: AnnotateInputSchema,
    output: AnnotateOutputSchema,
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    timeoutMs: 5_000,
    handler: async (input, signal) => {
      if (signal?.aborted) throw new Error("Cancelled by client");
      return annotate(input);
    },
  };
