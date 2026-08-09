/**
 * MCP tool I/O schemas — the per-tool input/output shapes the registry
 * validates against. Covers the demo/health/log tools, the read/write tab &
 * window commands, and screenshots. Untrusted text fields (url/title) are
 * wrapped at the tool boundary, not here.
 */

import { z } from "zod";
import { BrowserIdSchema, WindowBoundsSchema } from "./base.js";
import { WindowStateSchema } from "./enrichment.js";

// ── noop demo tool ────────────────────────────────────────────────────

/**
 * Input for the `noop` demo tool — exists purely so the starter has a
 * realistic round-trip example through both TS and Rust paths.
 */
export const NoopInputSchema = z.object({
  input: z.string().describe("Arbitrary string. Will be echoed back."),
  upper: z.boolean().default(false).describe("If true, return the echoed string in upper-case."),
});
export type NoopInput = z.infer<typeof NoopInputSchema>;

export const NoopOutputSchema = z.object({
  echo: z.string().describe("The echoed (possibly upper-cased) string."),
  engine: z.enum(["ts", "rust"]).describe("Which implementation path produced the result."),
  durationMicros: z.number().int().describe("Wall-clock duration in microseconds."),
});
export type NoopOutput = z.infer<typeof NoopOutputSchema>;

// ── health_check ──────────────────────────────────────────────────────

/**
 * health_check tool input — no arguments. Keeps the schema declared so
 * `toMcpTools()` always has a valid input schema.
 */
export const HealthCheckInputSchema = z.object({});
export type HealthCheckInput = z.infer<typeof HealthCheckInputSchema>;

export const HealthSnapshotSchema = z.object({
  status: z.enum(["healthy", "degraded", "unhealthy"]),
  issues: z.array(z.string()),
  uptimeS: z.number().int(),
  pid: z.number().int(),
  node: z.string(),
  heapMb: z.number(),
  rssMb: z.number(),
  eventLoopP99Ms: z.number(),
  eventLoopMaxMs: z.number(),
  toolCalls: z.number().int(),
  recentErrors: z.number().int(),
  lastActivityAgeS: z.number().int(),
});
export type HealthSnapshotShape = z.infer<typeof HealthSnapshotSchema>;

// ── get_logs (dev-only) ───────────────────────────────────────────────

export const GetLogsInputSchema = z.object({
  tail: z
    .number()
    .int()
    .min(1)
    .max(500)
    .default(50)
    .describe("Number of log lines to return (1-500). Default 50."),
  source: z
    .enum(["memory", "file", "all"])
    .default("memory")
    .describe("memory = in-process ring buffer; file = NDJSON on disk; all = both."),
});
export type GetLogsInput = z.infer<typeof GetLogsInputSchema>;

export const GetLogsOutputSchema = z.object({
  source: z.string(),
  lines: z.array(z.string()),
});
export type GetLogsOutput = z.infer<typeof GetLogsOutputSchema>;

// ── browser-tab tool inputs ───────────────────────────────────────────

export const ListTabsInputSchema = z.object({
  browser: BrowserIdSchema.optional().describe(
    "Restrict to one browser. Omit to scan all enabled browsers.",
  ),
  windowId: z.string().optional().describe("Restrict to one window (opaque windowId)."),
  urlFilter: z
    .string()
    .optional()
    .describe(
      "Case-insensitive substring match against tab URLs. Windows with no match are dropped.",
    ),
  fields: z
    .enum(["core", "full"])
    .default("core")
    .describe(
      "Projection. 'core' (default) trims enrichment fields, tab groups and capabilities for " +
        "token economy; 'full' returns everything. The snapshot file + CLI always emit full.",
    ),
});
export type ListTabsInput = z.infer<typeof ListTabsInputSchema>;

export const FocusTabInputSchema = z.object({
  tabId: z.string().describe("Opaque tab handle from list_tabs."),
  raiseWindow: z
    .boolean()
    .default(true)
    .describe(
      "Also raise the tab's window: un-minimize it and bring it to the front (the default, and " +
        "what every pathway did before this flag existed). Set false to activate the tab in place " +
        "— no raise, no un-minimize — e.g. when a window manager owns window placement and only " +
        "needs the tab selected.",
    ),
});
export type FocusTabInput = z.infer<typeof FocusTabInputSchema>;

export const CloseTabInputSchema = z.object({
  tabId: z.string().describe("Opaque tab handle from list_tabs."),
});
export type CloseTabInput = z.infer<typeof CloseTabInputSchema>;

export const MoveTabInputSchema = z.object({
  tabId: z.string().describe("Opaque tab handle from list_tabs."),
  targetWindowId: z
    .string()
    .optional()
    .describe("Destination window. Omit with newWindow=true to split into a new window."),
  targetIndex: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("0-based destination position. Omit to append at the end."),
  newWindow: z.boolean().default(false).describe("Move the tab into a newly created window."),
  targetGroupId: z
    .string()
    .optional()
    .describe(
      "After moving, add the tab to this existing tab group (opaque g:<browser>:x<id> handle). " +
        "Extension pathway only (Chrome-family).",
    ),
  allowReload: z
    .boolean()
    .default(false)
    .describe(
      "Safari only: permit the AppleScript move, which reloads the page (loses scroll/form/JS " +
        "state). Without the Safari extension connected, Safari moves require this flag.",
    ),
});
export type MoveTabInput = z.infer<typeof MoveTabInputSchema>;

export const OpenTabInputSchema = z.object({
  url: z.string().describe("http(s) URL to open."),
  browser: BrowserIdSchema.optional().describe("Browser to open in. Default: first enabled."),
  windowId: z
    .string()
    .optional()
    .describe("Window to open the tab in. Omit for the frontmost window."),
  activate: z.boolean().default(true).describe("Bring the tab/window to the foreground."),
  index: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("0-based insertion position within the window. Extension pathway only."),
  pinned: z
    .boolean()
    .default(false)
    .describe("Open the tab pinned. Extension pathway only (ignored under AppleScript)."),
  groupId: z
    .string()
    .optional()
    .describe(
      "Add the new tab to this existing tab group (opaque g:<browser>:x<id> handle). " +
        "Extension pathway only.",
    ),
});
export type OpenTabInput = z.infer<typeof OpenTabInputSchema>;

// ── write-side control tool inputs (PR3) ──────────────────────────────

/** A single-tab imperative action. `navigate` requires `url`. */
export const TabActionSchema = z.enum([
  "mute",
  "unmute",
  "pin",
  "unpin",
  "discard",
  "reload",
  "navigate",
  "back",
  "forward",
  "duplicate",
]);
export type TabAction = z.infer<typeof TabActionSchema>;

export const TabActionInputSchema = z.object({
  tabId: z.string().describe("Opaque tab handle from list_tabs."),
  action: TabActionSchema.describe(
    "mute/unmute audio · pin/unpin · discard (unload) · reload · navigate (needs url) · " +
      "back/forward in history · duplicate. AppleScript supports navigate/reload (+ back/forward " +
      "on Chromium); the rest need the extension.",
  ),
  url: z.string().optional().describe('http(s) URL — required when action is "navigate".'),
});
export type TabActionInput = z.infer<typeof TabActionInputSchema>;

/** Tab-group operations. Extension pathway only (Chrome-family tabGroups API). */
export const GroupActionSchema = z.enum(["create", "add", "remove", "update", "move"]);
export type GroupAction = z.infer<typeof GroupActionSchema>;

export const GroupTabsInputSchema = z.object({
  action: GroupActionSchema.describe(
    "create a group from tabIds · add tabIds to groupId · remove tabIds from their group · " +
      "update a group's title/color/collapsed · move a group to another window/index.",
  ),
  browser: BrowserIdSchema.optional().describe(
    "Browser to act on. Usually inferred from tabIds/groupId; needed only when neither is a handle.",
  ),
  tabIds: z.array(z.string()).optional().describe("Tab handles (create/add/remove)."),
  groupId: z
    .string()
    .optional()
    .describe("Existing group handle g:<browser>:x<id> (add/remove/update/move)."),
  title: z.string().optional().describe("Group title (create/update)."),
  color: z
    .string()
    .optional()
    .describe("Group color (create/update): grey|blue|red|yellow|green|pink|purple|cyan|orange."),
  collapsed: z.boolean().optional().describe("Collapse/expand the group (update)."),
  targetWindowId: z.string().optional().describe("Destination window handle (move)."),
  index: z.number().int().optional().describe("0-based destination position (move)."),
});
export type GroupTabsInput = z.infer<typeof GroupTabsInputSchema>;

export const OpenWindowInputSchema = z.object({
  urls: z
    .array(z.string())
    .min(1)
    .describe("http(s) URLs to open; the first becomes the active tab."),
  browser: BrowserIdSchema.optional().describe("Browser to open in. Default: first enabled."),
  bounds: WindowBoundsSchema.optional().describe(
    "Explicit global-coordinate frame {x,y,w,h}. Takes precedence over display; forces state normal.",
  ),
  display: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "0-based display index to place the window on (fills that display). " +
        "Ignored when bounds is given; needs the native module.",
    ),
  state: WindowStateSchema.optional().describe(
    "Initial window state. Mutually exclusive with bounds/display.",
  ),
  incognito: z.boolean().default(false).describe("Open a private/incognito window."),
  focused: z.boolean().default(true).describe("Bring the new window to the foreground."),
});
export type OpenWindowInput = z.infer<typeof OpenWindowInputSchema>;

export const SetWindowInputSchema = z.object({
  windowId: z.string().describe("Opaque window handle from list_tabs."),
  bounds: WindowBoundsSchema.optional().describe("New global-coordinate frame {x,y,w,h}."),
  display: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      "0-based display index to move the window to (fills it). Ignored when bounds is given.",
    ),
  state: WindowStateSchema.optional().describe(
    "New window state. Mutually exclusive with bounds/display.",
  ),
  focused: z.boolean().optional().describe("Raise/foreground the window."),
});
export type SetWindowInput = z.infer<typeof SetWindowInputSchema>;

export const CloseWindowInputSchema = z.object({
  windowId: z.string().describe("Opaque window handle from list_tabs."),
});
export type CloseWindowInput = z.infer<typeof CloseWindowInputSchema>;

export const DaemonStatusInputSchema = z.object({});
export type DaemonStatusInput = z.infer<typeof DaemonStatusInputSchema>;

/**
 * daemon_status output. Permissive (passthrough) — the daemon adds
 * per-browser detail, correlation tier, uptime, etc.
 */
export const DaemonStatusOutputSchema = z
  .object({
    reachable: z.boolean().describe("Whether the daemon answered on its unix socket."),
  })
  .passthrough();
export type DaemonStatusOutput = z.infer<typeof DaemonStatusOutputSchema>;

export const CommandResultSchema = z.object({
  ok: z.boolean(),
  command: z.string().describe("Which command ran, e.g. focus_tab."),
  browser: BrowserIdSchema,
  tabId: z.string().optional().describe("Tab affected (may be reissued after a move)."),
  windowId: z.string().optional().describe("Window the tab ended up in."),
  groupId: z.string().optional().describe("Tab group affected (group_tabs)."),
  index: z.number().int().optional().describe("0-based final position of the tab."),
  payload: z
    .unknown()
    .optional()
    .describe("Command-specific extra data (e.g. the action performed, window bounds)."),

  // ── window post-state (focus_tab) ───────────────────────────────────
  //
  // browser-tab is NOT responsible for Spaces or window visibility — that is
  // the window manager's job. What it owes a WM is enough post-state to decide
  // for itself without a second list_tabs round-trip: the CoreGraphics id to
  // join on, what state the window is in, whether it had to be un-minimized,
  // and whether it ended up frontmost. Deliberately no yabai actuation here.
  //
  // All four are additive-optional, so the Snapshot contract `version` does NOT
  // move for them (see the contract invariant in AGENTS.md).
  cgWindowId: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe(
      "CoreGraphics window id (== yabai window id) of the affected window — the join key against " +
        "`yabai -m query --windows`. Null when correlation is unavailable or ambiguous; absent " +
        "when the command did not run through the daemon (correlation lives there).",
    ),
  windowState: WindowStateSchema.optional().describe(
    "Window state after the command. Absent when the pathway cannot observe it.",
  ),
  wasMinimized: z
    .boolean()
    .optional()
    .describe(
      "True when the window was minimized BEFORE the command ran — i.e. the tab was somewhere the " +
        "user could not see. Only the acting pathway can observe this, so it is never backfilled.",
    ),
  windowFocused: z
    .boolean()
    .optional()
    .describe(
      "True when the window is its browser's frontmost window after the command (same meaning as " +
        "`focused` on a snapshot window — it says nothing about which app owns the OS focus).",
    ),
});
export type CommandResult = z.infer<typeof CommandResultSchema>;

// ── screenshots ───────────────────────────────────────────────────────
//
// Two tiers, one tool. Tier "tab": the extension's captureVisibleTab (the
// active tab of a window, no TCC, jpeg q70, rate-limited). Tier "window":
// the daemon's `screencapture -l <cgWindowId>` (any visible window, any
// browser) behind BROWSER_TAB_WINDOW_CAPTURE + Screen Recording TCC. The
// daemon writes the jpeg to its shots cache and returns the path + bytes;
// the MCP tool reads that file back into an image content block.

/** What the extension's `capture_tab` command returns (data URL of the jpeg). */
export const CaptureResultSchema = z.object({
  dataUrl: z.string().describe("data:image/jpeg;base64,… of the visible tab."),
});
export type CaptureResult = z.infer<typeof CaptureResultSchema>;

export const ScreenshotInputSchema = z
  .object({
    tabId: z
      .string()
      .optional()
      .describe("Tab handle from list_tabs (tier 'tab' — extension captureVisibleTab)."),
    windowId: z
      .string()
      .optional()
      .describe("Window handle from list_tabs (tier 'window' — daemon screencapture, opt-in)."),
    force: z
      .boolean()
      .default(false)
      .describe("Bypass the navEpoch-keyed shot cache and recapture."),
    focus: z
      .boolean()
      .default(false)
      .describe(
        "Tier 'tab' only: if the tab isn't its window's active tab, activate it first (changes user state) then capture.",
      ),
  })
  .refine((v) => (v.tabId === undefined) !== (v.windowId === undefined), {
    message: "Pass exactly one of tabId (tier 'tab') or windowId (tier 'window').",
  });
export type ScreenshotInput = z.infer<typeof ScreenshotInputSchema>;

export const ScreenshotOutputSchema = z.object({
  tier: z.enum(["tab", "window"]).describe("Which capture path produced the image."),
  path: z.string().describe("Absolute path to the jpeg in the daemon shot cache."),
  bytes: z.number().int().describe("File size in bytes."),
  format: z.literal("jpeg"),
  cached: z
    .boolean()
    .describe("True when an existing shot at this navEpoch was reused (tier 'tab')."),
  navEpoch: z
    .number()
    .int()
    .optional()
    .describe("Tab navigation epoch the shot was taken at (tier 'tab' only)."),
});
export type ScreenshotOutput = z.infer<typeof ScreenshotOutputSchema>;
