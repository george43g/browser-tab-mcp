/**
 * Focus / navigation journals.
 *
 * The daemon's event-sourced memory of where the user has been. Records
 * denormalize url/title so history survives handle churn (handles aren't
 * stable across generations/sessions). Records are for correlation, not for
 * issuing commands — re-run list_tabs for live handles.
 */

import { z } from "zod";
import { BrowserIdSchema } from "./base.js";
import { PageStateSchema } from "./page.js";

export const FocusRecordSchema = z.object({
  ts: z.number().int().describe("Epoch ms of the focus change."),
  browser: BrowserIdSchema,
  kind: z.enum(["window-focus", "tab-focus"]),
  windowId: z.string().describe("Opaque window handle (may be stale — for correlation)."),
  tabId: z.string().optional().describe("Opaque tab handle (tab-focus only)."),
  url: z.string().optional().describe("Denormalized at capture time. Untrusted."),
  title: z.string().optional().describe("Denormalized at capture time. Untrusted."),
  source: z
    .enum(["ext", "applescript", "seed"])
    .describe("ext = live event frame; applescript = poll-derived; seed = lastAccessed backfill."),
  capture: PageStateSchema.optional().describe(
    "Page state as the user left this tab (blur capture, backfilled onto the focus record).",
  ),
});
export type FocusRecord = z.infer<typeof FocusRecordSchema>;

export const NavRecordSchema = z.object({
  ts: z.number().int().describe("Epoch ms of the committed navigation."),
  browser: BrowserIdSchema,
  tabId: z.string().describe("Opaque tab handle (may be stale — for correlation)."),
  url: z.string().describe("Committed URL. Untrusted web content."),
  title: z.string().optional().describe("Denormalized at capture time. Untrusted."),
  transition: z.string().optional().describe("webNavigation transitionType."),
  navEpoch: z.number().int().describe("Per-tab navigation counter (cache-busting key)."),
  source: z.enum(["ext", "applescript"]),
});
export type NavRecord = z.infer<typeof NavRecordSchema>;

export const JournalInputSchema = z.object({
  view: z
    .enum(["windowMru", "tabMru", "journey", "recent"])
    .default("recent")
    .describe(
      "windowMru = windows by last-focus (cross-browser); tabMru = a window's tabs by last-focus; " +
        "journey = a tab's navigation chain; recent = raw focus tail.",
    ),
  browser: BrowserIdSchema.optional(),
  windowId: z.string().optional().describe("Required for tabMru — the window whose tab history."),
  tabId: z.string().optional().describe("Required for journey — the tab whose nav chain."),
  limit: z.number().int().min(1).max(200).default(20),
});
export type JournalInput = z.infer<typeof JournalInputSchema>;

export const JournalOutputSchema = z.object({
  view: z.string(),
  focus: z
    .array(FocusRecordSchema)
    .default([])
    .describe("Populated for windowMru / tabMru / recent."),
  nav: z.array(NavRecordSchema).default([]).describe("Populated for journey."),
});
export type JournalOutput = z.infer<typeof JournalOutputSchema>;
