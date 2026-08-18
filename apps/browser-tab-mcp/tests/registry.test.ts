/**
 * makeAppRegistry catalog integrity — guards against a tool being silently
 * dropped or double-registered (the catalog is the MCP surface), and pins
 * that the dev-only tool (`get_logs`) is filtered out of the default MCP
 * tool list unless dev mode is on.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { devModeEnabled, makeAppRegistry } from "../src/tools/registry.js";

const EXPECTED = [
  "health_check",
  "list_tabs",
  "focus_tab",
  "move_tab",
  "open_tab",
  "close_tab",
  "tab_action",
  "group_tabs",
  "open_window",
  "set_window",
  "close_window",
  "get_page",
  "annotate",
  "screenshot",
  "journal",
  "history",
  "bookmarks",
  "daemon_status",
  "noop",
  "get_logs",
];

describe("makeAppRegistry", () => {
  const reg = makeAppRegistry();

  it("exposes exactly the expected tool catalog", () => {
    expect(reg.tools.map((t) => t.name).sort()).toEqual([...EXPECTED].sort());
  });

  it("registers no duplicate tool names", () => {
    const names = reg.tools.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("resolves a known tool and returns undefined for an unknown one", () => {
    expect(reg.get("health_check")?.name).toBe("health_check");
    expect(reg.get("does_not_exist")).toBeUndefined();
  });

  it("filters the dev-only get_logs out of the default MCP tool list", () => {
    expect(reg.toMcpTools(false).map((t) => t.name)).not.toContain("get_logs");
    expect(reg.toMcpTools(true).map((t) => t.name)).toContain("get_logs");
  });
});

describe("devModeEnabled", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("is false by default", () => {
    vi.stubEnv("MCP_DEV", "");
    expect(devModeEnabled()).toBe(false);
  });

  it("is true when MCP_DEV=1", () => {
    vi.stubEnv("MCP_DEV", "1");
    expect(devModeEnabled()).toBe(true);
  });
});
