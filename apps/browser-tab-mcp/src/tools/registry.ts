/**
 * Tool registry — single source of truth for which tools this MCP exposes.
 *
 * Adding a tool:
 *   1. Create `src/tools/<name>.ts` matching the noop pattern.
 *   2. Import it here and add to the array below.
 *   3. Add an integration test in `tests/integration.test.ts`.
 *   4. If lifecycle-affecting, add a stress case in `scripts/stress-mcp.ts`.
 */

import { makeRegistry, type ToolRegistry } from "@george43g/mcp-kit";
import { envBool } from "@george43g/robustness";
import { annotateTool } from "./annotate.js";
import { applyTabLayoutTool } from "./apply-tab-layout.js";
import { bookmarksTool } from "./bookmarks.js";
import { closeTabTool } from "./close-tab.js";
import { closeWindowTool } from "./close-window.js";
import { daemonStatusTool } from "./daemon-status.js";
import { focusTabTool } from "./focus-tab.js";
import { getLogsTool } from "./get-logs.js";
import { getPageTool } from "./get-page.js";
import { groupTabsTool } from "./group-tabs.js";
import { healthCheckTool } from "./health-check.js";
import { historyTool } from "./history.js";
import { journalTool } from "./journal.js";
import { listTabsTool } from "./list-tabs.js";
import { moveTabTool } from "./move-tab.js";
import { noopTool } from "./noop.js";
import { openTabTool } from "./open-tab.js";
import { openWindowTool } from "./open-window.js";
import { planTabChangeTool } from "./plan-tab-change.js";
import { screenshotTool } from "./screenshot.js";
import { selectTabsTool } from "./select-tabs.js";
import { setWindowTool } from "./set-window.js";
import { tabActionTool } from "./tab-action.js";

export function makeAppRegistry(): ToolRegistry {
  return makeRegistry([
    healthCheckTool,
    listTabsTool,
    focusTabTool,
    moveTabTool,
    openTabTool,
    closeTabTool,
    tabActionTool,
    groupTabsTool,
    openWindowTool,
    setWindowTool,
    closeWindowTool,
    getPageTool,
    annotateTool,
    screenshotTool,
    selectTabsTool,
    planTabChangeTool,
    applyTabLayoutTool,
    journalTool,
    historyTool,
    bookmarksTool,
    daemonStatusTool,
    noopTool,
    getLogsTool,
  ]);
}

export function devModeEnabled(): boolean {
  return envBool("MCP_DEV", false);
}
