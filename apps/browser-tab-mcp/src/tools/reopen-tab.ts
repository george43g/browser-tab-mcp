/**
 * reopen_tab — bring a closed tab back, and say which kind of "back" it was.
 *
 * Phase 5 PR-P. The result's `method` and `historyPreserved` are the point:
 * a session-restore returns the tab with its back/forward history, while a
 * reconstruction is a new tab pointing at the same URL. Reporting the second
 * as if it were the first is the half-truth someone discovers by pressing
 * Back and landing nowhere.
 */

import type { ToolDefinition } from "@george43g/mcp-kit";
import { z } from "zod";
import { reopenTab } from "../client/tabs-service.js";

export const ReopenTabInputSchema = z.object({
  closedTabId: z
    .string()
    .describe("A closedTabId from closed_tabs. Aged-out ids are refused, not guessed at."),
});

export const ReopenTabOutputSchema = z.object({
  closedTabId: z.string(),
  method: z
    .enum(["session-restore", "reconstructed"])
    .describe(
      "session-restore = the browser's own recently-closed entry, history intact. " +
        "reconstructed = a new tab at the same URL, with nothing behind it.",
    ),
  historyPreserved: z.boolean(),
  url: z.string(),
  tabId: z.string().optional(),
  windowId: z.string().optional(),
  warnings: z.array(z.string()),
});

export const reopenTabTool: ToolDefinition<
  typeof ReopenTabInputSchema,
  typeof ReopenTabOutputSchema
> = {
  name: "reopen_tab",
  description:
    "Reopen a tab from closed_tabs. Prefers the browser's own recently-closed entry, which " +
    "restores back/forward history; falls back to opening the recorded URL at its old position, " +
    "which does not. The result says which happened (method, historyPreserved) rather than " +
    "leaving you to find out by pressing Back. When only a WHOLE-WINDOW restore is available it " +
    "reconstructs the single tab and warns, because restoring nine tabs is not a more generous " +
    "answer to a request for one. Requires the daemon and the browser extension.",
  input: ReopenTabInputSchema,
  output: ReopenTabOutputSchema,
  annotations: {
    title: "Reopen a closed tab",
    readOnlyHint: false,
    // Additive: it brings a tab back. Nothing user-owned is lost either way.
    destructiveHint: false,
    idempotentHint: false,
    // It navigates to a URL the user previously had open.
    openWorldHint: true,
  },
  timeoutMs: 20_000,
  handler: async (input, signal) => {
    if (signal?.aborted) throw new Error("Cancelled by client");
    return (await reopenTab({ closedTabId: input.closedTabId })) as z.infer<
      typeof ReopenTabOutputSchema
    >;
  },
};
