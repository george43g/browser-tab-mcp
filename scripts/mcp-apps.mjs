#!/usr/bin/env node
/**
 * mcp-apps.mjs — print the package NAME of every MCP app workspace, one per
 * line; exit 1 if there are none.
 *
 * A thin CLI over scripts/lib/mcp-apps.mjs, which holds the marker, the
 * selection rule and the empty-set failure, and which for-each-mcp-app.mjs
 * imports directly. Deliberately NOT a module that also self-detects "was I run
 * directly?" — the argv/realpath comparison that needs is wrong under macOS's
 * /var → /private/var symlink and fails by printing nothing and exiting 0,
 * which is precisely the silent-empty failure this whole change exists to end.
 *
 * Useful by hand, and as the thing a human can run to see what the gates will
 * actually cover: `node scripts/mcp-apps.mjs`.
 */

import { requireMcpApps } from "./lib/mcp-apps.mjs";

for (const app of requireMcpApps("mcp-apps")) console.log(app.name);
