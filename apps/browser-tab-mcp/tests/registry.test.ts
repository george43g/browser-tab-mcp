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
  "copy_tabs",
  "cut_tabs",
  "get_page",
  "annotate",
  "apply_tab_layout",
  "apply_destructive_plan",
  "plan_tab_change",
  "screenshot",
  "select_tabs",
  "journal",
  "history",
  "bookmarks",
  "closed_tabs",
  "reopen_tab",
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

  it("emits no $schema dialect label on any tool schema (eqstack #184 guard)", () => {
    const tools = reg.toMcpTools(true) as unknown as Array<{
      inputSchema: Record<string, unknown>;
      outputSchema?: Record<string, unknown>;
    }>;
    expect(tools.length).toBeGreaterThan(0);
    for (const t of tools) {
      expect(t.inputSchema).not.toHaveProperty("$schema");
      expect(t.outputSchema).toBeDefined();
      expect(t.outputSchema).not.toHaveProperty("$schema");
    }
  });

  it("emits no draft-07-only keyword a 2020-12 validator rejects, on any tool", () => {
    // select_tabs, plan_tab_change, copy_tabs and cut_tabs carry a z.tuple
    // (anchors); draft-07 emits it as array-form `items`, 2020-12 as prefixItems.
    const draft07Only = (n: unknown, at: string): string[] =>
      Array.isArray(n)
        ? n.flatMap((x, i) => draft07Only(x, `${at}[${i}]`))
        : n && typeof n === "object"
          ? Object.entries(n).flatMap(([k, v]) => [
              ...((k === "items" && Array.isArray(v)) ||
              k === "definitions" ||
              k === "dependencies" ||
              k === "additionalItems"
                ? [`${at}.${k}`]
                : []),
              ...draft07Only(v, `${at}.${k}`),
            ])
          : [];
    const tools = reg.toMcpTools(true) as unknown as Array<{ name: string }>;
    expect(tools.flatMap((t) => draft07Only(t, t.name))).toEqual([]);
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
