/**
 * Extension ↔ daemon WebSocket protocol.
 *
 * One protocol for every browser's extension. NDJSON-over-WebSocket:
 * client (extension) authenticates with `hello`, then streams debounced
 * full `snapshot`s; the daemon pushes `command`s and keepalive `ping`s.
 */

import { z } from "zod";
import { BrowserIdSchema, CapabilitiesSchema, WindowBoundsSchema } from "./base.js";
import { TabEnrichmentSchema, WindowEnrichmentSchema } from "./enrichment.js";
import { PageStateSchema } from "./page.js";

/**
 * The wire protocol revision both peers speak — the single source of truth for
 * the extension's `PROTOCOL_VERSION` and the daemon's staleness check. Bump it
 * when the extension↔daemon contract gains capabilities/commands a peer must
 * understand. A *deployed* extension bundle bakes in whatever value it was built
 * with, so a daemon newer than an un-reloaded extension detects the mismatch
 * (see the daemon's ws-server hello handler). v2 = capabilities + enrichments.
 */
export const WIRE_PROTOCOL_VERSION = 2;

export const ExtTabSchema = z
  .object({
    id: z.number().int().describe("Extension-native tab id (chrome.tabs id)."),
    windowId: z.number().int(),
    index: z.number().int(),
    url: z.string(),
    title: z.string(),
    active: z.boolean(),
    groupId: z
      .number()
      .int()
      .optional()
      .describe("chrome.tabGroups id when grouped (>=0); -1/absent means ungrouped."),
    favicon: z
      .string()
      .optional()
      .describe("Sanitized favicon (http(s) or bounded data:), set by the extension mapper."),
  })
  .merge(TabEnrichmentSchema);
export type ExtTab = z.infer<typeof ExtTabSchema>;

export const ExtTabGroupSchema = z.object({
  id: z.number().int().describe("chrome.tabGroups id."),
  windowId: z.number().int(),
  title: z.string().default(""),
  color: z.string(),
  collapsed: z.boolean().default(false),
});
export type ExtTabGroup = z.infer<typeof ExtTabGroupSchema>;

export const ExtWindowSchema = z
  .object({
    id: z.number().int().describe("Extension-native window id (chrome.windows id)."),
    focused: z.boolean(),
    incognito: z.boolean(),
    bounds: WindowBoundsSchema.nullable(),
    tabs: z.array(ExtTabSchema),
  })
  .merge(WindowEnrichmentSchema);
export type ExtWindow = z.infer<typeof ExtWindowSchema>;

export const ExtHelloSchema = z.object({
  type: z.literal("hello"),
  browser: BrowserIdSchema,
  extVersion: z.string(),
  token: z.string(),
  protocolVersion: z
    .number()
    .int()
    .optional()
    .describe("Wire protocol version the extension speaks. Absent = legacy (v1)."),
  capabilities: CapabilitiesSchema.optional().describe(
    "Runtime-probed feature availability for this browser. Absent = legacy defaults.",
  ),
});
export type ExtHello = z.infer<typeof ExtHelloSchema>;

export const ExtSnapshotSchema = z.object({
  type: z.literal("snapshot"),
  windows: z.array(ExtWindowSchema),
  groups: z
    .array(ExtTabGroupSchema)
    .default([])
    .describe("Tab groups across all windows (Chrome-family; empty/absent otherwise)."),
});
export type ExtSnapshot = z.infer<typeof ExtSnapshotSchema>;

export const ExtCommandSchema = z.object({
  type: z.literal("command"),
  requestId: z.number().int(),
  kind: z.enum([
    "focus_tab",
    "close_tab",
    "move_tab",
    "open_tab",
    "tab_action",
    "group_tabs",
    "open_window",
    "set_window",
    "close_window",
    "extract_content",
    "capture_tab",
    "history_search",
  ]),
  args: z.record(z.unknown()),
});
export type ExtCommand = z.infer<typeof ExtCommandSchema>;

export const ExtCommandResultSchema = z.object({
  type: z.literal("commandResult"),
  requestId: z.number().int(),
  ok: z.boolean(),
  result: z.record(z.unknown()).optional(),
  error: z.string().optional(),
});
export type ExtCommandResult = z.infer<typeof ExtCommandResultSchema>;

export const ExtPingSchema = z.object({ type: z.literal("ping"), ts: z.number() });
export type ExtPing = z.infer<typeof ExtPingSchema>;
export const ExtPongSchema = z.object({ type: z.literal("pong"), ts: z.number() });
export type ExtPong = z.infer<typeof ExtPongSchema>;

/**
 * A single immediate focus/navigation event frame (undebounced — the tiny
 * signal the daemon journals). Carries native chrome ids; the daemon
 * converts to opaque handles and denormalizes url/title. `kind:"focus"` with
 * a tabId is a tab focus, without it a window focus; `kind:"nav"` is a
 * committed top-frame navigation; `kind:"stateCapture"` is the one-shot state
 * snapshot of a tab as the user left it (blur capture) — the daemon backfills
 * it onto that tab's most recent focus record.
 */
export const ExtEventSchema = z.object({
  type: z.literal("event"),
  ts: z.number().int().describe("Epoch ms the event occurred (extension clock)."),
  kind: z.enum(["focus", "nav", "stateCapture"]),
  windowId: z.number().int().optional().describe("Native chrome.windows id."),
  tabId: z.number().int().optional().describe("Native chrome.tabs id."),
  url: z.string().optional().describe("Committed URL (nav only)."),
  transition: z.string().optional().describe("webNavigation transitionType (nav only)."),
  state: PageStateSchema.optional().describe("Page state as the tab was left (stateCapture only)."),
});
export type ExtEvent = z.infer<typeof ExtEventSchema>;

/** Every message an extension may send the daemon. */
export const ExtClientMessageSchema = z.discriminatedUnion("type", [
  ExtHelloSchema,
  ExtSnapshotSchema,
  ExtCommandResultSchema,
  ExtEventSchema,
  ExtPongSchema,
]);
export type ExtClientMessage = z.infer<typeof ExtClientMessageSchema>;

export const ExtHelloAckSchema = z.object({
  type: z.literal("helloAck"),
  protocolVersion: z
    .number()
    .int()
    .optional()
    .describe("Wire protocol version the daemon speaks. Old extensions ignore it."),
  config: z
    .object({
      blurCapture: z.boolean().describe("Capture prev-tab state on tab switch (capture-on-blur)."),
    })
    .optional()
    .describe("Daemon policy pushed to the extension. Absent = extension defaults."),
});
export type ExtHelloAck = z.infer<typeof ExtHelloAckSchema>;

/** Every message the daemon may send an extension. */
export const ExtServerMessageSchema = z.discriminatedUnion("type", [
  ExtHelloAckSchema,
  ExtCommandSchema,
  ExtPingSchema,
]);
export type ExtServerMessage = z.infer<typeof ExtServerMessageSchema>;
