/**
 * closed_tabs — what the daemon watched disappear (Phase 5 PR-O/PR-P).
 *
 * Promoted from a CLI-only read the moment `reopen_tab` existed: a list a
 * model can read but not act on is a tool whose only outcome is wanting
 * another one, and an act tool whose ids come from nowhere it can see is
 * unusable. They ship as a pair.
 */

import type { ToolDefinition } from "@george43g/mcp-kit";
import { z } from "zod";
import { listClosedTabs } from "../client/tabs-service.js";

export const ClosedTabsInputSchema = z.object({
  browser: z
    .enum(["chrome", "brave", "chromium", "edge", "safari"])
    .optional()
    .describe("Only this browser's closures. Omit for all of them."),
  limit: z.number().int().min(1).max(200).default(20).describe("How many, newest first."),
});

export const ClosedTabsOutputSchema = z.array(
  z
    .object({
      closedTabId: z.string().describe("Pass to reopen_tab."),
      tabId: z.string().describe("The handle it HAD — stale by definition, kept for correlation."),
      url: z.string(),
      title: z.string(),
      windowId: z.string(),
      windowGone: z.boolean().describe("True when the window went too — a reopen needs a new one."),
      closedAt: z.number(),
    })
    .passthrough(),
);

export const closedTabsTool: ToolDefinition<
  typeof ClosedTabsInputSchema,
  typeof ClosedTabsOutputSchema
> = {
  name: "closed_tabs",
  description:
    "Tabs the daemon watched disappear, newest first — url, title, where they were, whether the " +
    "window went too, and the group identity that dies with a group's last member. Reopenable " +
    "for a bounded window (BROWSER_TAB_CLOSED_TAB_TTL_MS, 6h by default), then aged out. " +
    "Cross-window moves, browser quits and extension/AppleScript authority switches are NOT " +
    "closures and never appear here. Requires the daemon — it is the daemon that does the " +
    "watching. Pair with reopen_tab.",
  input: ClosedTabsInputSchema,
  output: ClosedTabsOutputSchema,
  annotations: {
    title: "Recently closed tabs",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  timeoutMs: 10_000,
  handler: async (input, signal) => {
    if (signal?.aborted) throw new Error("Cancelled by client");
    return (await listClosedTabs({
      limit: input.limit,
      ...(input.browser !== undefined ? { browser: input.browser } : {}),
    })) as z.infer<typeof ClosedTabsOutputSchema>;
  },
};
