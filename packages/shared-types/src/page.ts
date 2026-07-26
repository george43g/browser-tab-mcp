/**
 * Page content & state.
 *
 * On-demand extraction injected into a tab (never a persistent content
 * script). The tool provides reader-mode text / metadata / live state
 * signals; the consumer AI interprets. All text fields are untrusted web
 * content — wrap before showing to an LLM.
 *
 * `PageStateSchema` is the one cross-cutting symbol: it's referenced by the
 * WS wire (ExtEvent) and the journals (FocusRecord), so it lives here in a
 * low layer both can import without a cycle.
 */

import { z } from "zod";

export const ExtractModeSchema = z
  .enum(["metadata", "text", "state"])
  .describe(
    "metadata = title/description/og/canonical; text = reader-mode article; state = live page signals.",
  );
export type ExtractMode = z.infer<typeof ExtractModeSchema>;

export const PageMetadataSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  ogTitle: z.string().optional(),
  ogDescription: z.string().optional(),
  ogImage: z.string().optional(),
  canonical: z.string().optional(),
  lang: z.string().optional(),
  siteName: z.string().optional(),
});
export type PageMetadata = z.infer<typeof PageMetadataSchema>;

export const PageMediaSchema = z.object({
  kind: z.enum(["audio", "video"]),
  paused: z.boolean(),
  currentTime: z.number(),
  duration: z.number(),
});
export type PageMedia = z.infer<typeof PageMediaSchema>;

/** Live "where did the user leave this page" signals — the blur capture. */
export const PageStateSchema = z.object({
  dirtyForms: z.number().int().describe("Count of forms with fields changed from their defaults."),
  focusedEditable: z.boolean().describe("An input/textarea/contenteditable has focus."),
  media: z.array(PageMediaSchema).default([]).describe("Playing/paused audio & video elements."),
  scrollY: z.number().describe("Vertical scroll offset in px."),
  scrollPct: z.number().describe("Scroll depth 0–100 (0 when the page doesn't scroll)."),
  selectionLength: z.number().int().describe("Length of the current text selection."),
  wordCount: z.number().int().describe("Approximate visible word count."),
});
export type PageState = z.infer<typeof PageStateSchema>;

/** What `__btExtract(mode)` returns from the injected script (mode-tagged). */
export const ExtractResultSchema = z.object({
  mode: ExtractModeSchema,
  url: z.string(),
  title: z.string().optional(),
  text: z.string().optional().describe("Reader-mode article text (text mode)."),
  byline: z.string().optional(),
  excerpt: z.string().optional(),
  metadata: PageMetadataSchema.optional(),
  state: PageStateSchema.optional(),
  truncated: z.boolean().optional().describe("True when text was capped at the byte budget."),
});
export type ExtractResult = z.infer<typeof ExtractResultSchema>;

export const GetPageInputSchema = z.object({
  tabId: z
    .string()
    .describe(
      "Tab handle from list_tabs (extension-generation only — content needs the extension).",
    ),
  mode: ExtractModeSchema.default("text"),
  force: z.boolean().default(false).describe("Bypass the navEpoch-keyed cache and re-extract."),
});
export type GetPageInput = z.infer<typeof GetPageInputSchema>;

export const GetPageOutputSchema = ExtractResultSchema.extend({
  navEpoch: z
    .number()
    .int()
    .describe("The tab's navigation epoch this content was captured at (ETag)."),
  cached: z.boolean().describe("True when served from the daemon content cache."),
});
export type GetPageOutput = z.infer<typeof GetPageOutputSchema>;

export const AnnotateInputSchema = z.object({
  url: z.string().describe("The URL to annotate (normalized for keying)."),
  note: z
    .string()
    .optional()
    .describe(
      "The note to store (e.g. a consumer's cached AI summary). Omit to read the existing note.",
    ),
});
export type AnnotateInput = z.infer<typeof AnnotateInputSchema>;

export const AnnotateOutputSchema = z.object({
  url: z.string(),
  note: z.string().optional(),
  updatedAt: z.number().int().optional().describe("Epoch ms the note was last set."),
  existed: z.boolean().describe("Whether a note existed before this call."),
});
export type AnnotateOutput = z.infer<typeof AnnotateOutputSchema>;
