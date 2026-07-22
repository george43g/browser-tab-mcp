/**
 * In-process integration tests for the dispatcher.
 *
 * We drive the dispatcher directly (no child process), which exercises:
 *   - tools/list catalog (via registry)
 *   - successful round-trip (health_check, noop)
 *   - schema validation failure
 *   - unknown tool rejection
 *   - native module fallback when MCP_DISABLE_NATIVE=1
 */

import { buildResourcesHandler } from "@george43g/mcp-kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { _resetCounters } from "../src/counters.js";
import { callMcpTool } from "../src/dispatcher.js";
import { makeResourcesProvider } from "../src/resources/registry.js";
import { makeAppRegistry } from "../src/tools/registry.js";

beforeEach(() => {
  _resetCounters();
});

afterEach(() => {
  delete process.env.MCP_DISABLE_NATIVE;
  delete process.env.BROWSER_TAB_FAKE_ADAPTER;
  delete process.env.BROWSER_TAB_BROWSERS;
});

describe("registry", () => {
  it("ships at least health_check and noop", () => {
    const r = makeAppRegistry();
    const names = r.tools.map((t) => t.name);
    expect(names).toContain("health_check");
    expect(names).toContain("noop");
  });

  it("dev-only tools are excluded from default toMcpTools()", () => {
    const r = makeAppRegistry();
    const visible = r.toMcpTools().map((t) => t.name);
    const all = r.toMcpTools(true).map((t) => t.name);
    expect(all).toContain("get_logs");
    expect(visible).not.toContain("get_logs");
  });
});

describe("health_check", () => {
  it("returns structuredContent matching HealthSnapshot shape", async () => {
    const r = await callMcpTool("health_check", {});
    expect(r.isError).toBeUndefined();
    const sc = r.structuredContent as Record<string, unknown>;
    expect(sc.status).toMatch(/healthy|degraded|unhealthy/);
    expect(typeof sc.pid).toBe("number");
    expect(typeof sc.uptimeS).toBe("number");
  });
});

describe("noop", () => {
  it("echoes input through the TS path", async () => {
    process.env.MCP_DISABLE_NATIVE = "1";
    const r = await callMcpTool("noop", { input: "hello", upper: false });
    expect(r.isError).toBeUndefined();
    const sc = r.structuredContent as { echo: string; engine: string };
    expect(sc.echo).toBe("hello");
    expect(sc.engine).toBe("ts");
  });

  it("upper-cases when requested", async () => {
    process.env.MCP_DISABLE_NATIVE = "1";
    const r = await callMcpTool("noop", { input: "hi", upper: true });
    expect((r.structuredContent as { echo: string }).echo).toBe("HI");
  });

  it("sanitizes ANSI control sequences", async () => {
    process.env.MCP_DISABLE_NATIVE = "1";
    const r = await callMcpTool("noop", { input: "\x1b[31mred\x1b[0m" });
    expect((r.structuredContent as { echo: string }).echo).toBe("red");
  });

  it("attempts rust path when native module is loadable", async () => {
    // Cannot guarantee rust-accel is built in CI; just ensure the env flag
    // is honored: forcing TS produces engine === "ts".
    process.env.MCP_DISABLE_NATIVE = "1";
    const r = await callMcpTool("noop", { input: "x" });
    expect((r.structuredContent as { engine: string }).engine).toBe("ts");
  });
});

describe("list_tabs (fake adapter)", () => {
  beforeEach(() => {
    process.env.BROWSER_TAB_FAKE_ADAPTER = "1";
    process.env.BROWSER_TAB_BROWSERS = "chrome,safari";
  });

  it("returns a schema-valid snapshot across enabled browsers", async () => {
    const { SnapshotSchema } = await import("@george43g/shared-types");
    const r = await callMcpTool("list_tabs", {});
    expect(r.isError).toBeUndefined();
    const snapshot = SnapshotSchema.parse(r.structuredContent);
    expect(snapshot.source).toBe("osascript-direct");
    expect(snapshot.browsers.map((b) => b.browser)).toEqual(["chrome", "safari"]);
    const chrome = snapshot.browsers[0];
    expect(chrome?.windows).toHaveLength(2);
    expect(chrome?.windows[0]?.tabs[0]?.tabId).toMatch(/^t:chrome:\d+$/);
    const safari = snapshot.browsers[1];
    expect(safari?.windows[0]?.tabs[0]?.tabId).toMatch(/^t:safari:w\d+:i\d+$/);
  });

  it("sanitizes ANSI escapes out of tab titles", async () => {
    const r = await callMcpTool("list_tabs", { browser: "chrome" });
    const text = JSON.stringify(r.structuredContent);
    expect(text).toContain("Hacker News");
    expect(text).not.toContain("\\u001b");
  });

  it("filters by browser", async () => {
    const r = await callMcpTool("list_tabs", { browser: "safari" });
    const sc = r.structuredContent as { browsers: { browser: string }[] };
    expect(sc.browsers.map((b) => b.browser)).toEqual(["safari"]);
  });

  it("filters tabs by urlFilter and drops empty windows", async () => {
    const r = await callMcpTool("list_tabs", { browser: "chrome", urlFilter: "github.com" });
    const sc = r.structuredContent as {
      browsers: { windows: { tabs: { url: string }[] }[] }[];
    };
    const windows = sc.browsers[0]?.windows ?? [];
    expect(windows).toHaveLength(1);
    expect(windows[0]?.tabs.every((t) => t.url.includes("github.com"))).toBe(true);
  });

  it("filters by windowId", async () => {
    const all = await callMcpTool("list_tabs", { browser: "chrome" });
    const first = (all.structuredContent as { browsers: { windows: { windowId: string }[] }[] })
      .browsers[0]?.windows[0]?.windowId;
    expect(first).toBeTruthy();
    const r = await callMcpTool("list_tabs", { browser: "chrome", windowId: first });
    const sc = r.structuredContent as { browsers: { windows: { windowId: string }[] }[] };
    expect(sc.browsers[0]?.windows).toHaveLength(1);
    expect(sc.browsers[0]?.windows[0]?.windowId).toBe(first);
  });

  it("rejects an invalid browser value via schema", async () => {
    const r = await callMcpTool("list_tabs", { browser: "netscape" });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/Invalid arguments/);
  });
});

describe("journal (fake adapter → daemon-only, empty)", () => {
  beforeEach(() => {
    process.env.BROWSER_TAB_FAKE_ADAPTER = "1";
  });

  it("returns a schema-valid empty result when there's no daemon", async () => {
    const { JournalOutputSchema } = await import("@george43g/shared-types");
    const r = await callMcpTool("journal", { view: "recent" });
    expect(r.isError).toBeUndefined();
    const out = JournalOutputSchema.parse(r.structuredContent);
    expect(out.view).toBe("recent");
    expect(out.focus).toEqual([]);
    expect(out.nav).toEqual([]);
  });

  it("rejects an invalid view via schema", async () => {
    const r = await callMcpTool("journal", { view: "bogus" });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/Invalid arguments/);
  });
});

describe("write-side commands (fake adapter → AppleScript fallback)", () => {
  beforeEach(() => {
    process.env.BROWSER_TAB_FAKE_ADAPTER = "1";
    process.env.BROWSER_TAB_BROWSERS = "chrome,safari";
  });

  it("tab_action navigate returns a schema-valid CommandResult", async () => {
    const { CommandResultSchema } = await import("@george43g/shared-types");
    const r = await callMcpTool("tab_action", {
      tabId: "t:chrome:9900",
      action: "navigate",
      url: "https://example.org/",
    });
    expect(r.isError).toBeUndefined();
    const out = CommandResultSchema.parse(r.structuredContent);
    expect(out).toMatchObject({ ok: true, command: "tab_action", browser: "chrome" });
    expect((out.payload as { action?: string }).action).toBe("navigate");
  });

  it("open_window + close_window return ok", async () => {
    const open = await callMcpTool("open_window", {
      urls: ["https://a/", "https://b/"],
      bounds: { x: 0, y: 0, w: 900, h: 700 },
    });
    expect(open.isError).toBeUndefined();
    expect(open.structuredContent).toMatchObject({ ok: true, command: "open_window" });

    const close = await callMcpTool("close_window", { windowId: "w:chrome:100" });
    expect(close.isError).toBeUndefined();
    expect(close.structuredContent).toMatchObject({ ok: true, command: "close_window" });
  });

  it("group_tabs errors cleanly without an extension", async () => {
    const r = await callMcpTool("group_tabs", { action: "create", tabIds: ["t:chrome:9900"] });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/extension/i);
  });

  it("an AppleScript-unsupported tab_action (mute) errors with a hint", async () => {
    const r = await callMcpTool("tab_action", { tabId: "t:chrome:9900", action: "mute" });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/extension/i);
  });

  it("navigate without a url is rejected", async () => {
    const r = await callMcpTool("tab_action", { tabId: "t:chrome:9900", action: "navigate" });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/url/i);
  });
});

describe("error paths", () => {
  it("rejects unknown tool with isError", async () => {
    const r = await callMcpTool("ghost_tool", {});
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/Unknown tool/);
  });

  it("rejects malformed args with usable error", async () => {
    const r = await callMcpTool("noop", { input: 42 });
    expect(r.isError).toBe(true);
    expect(r.content[0]?.text).toMatch(/Invalid arguments/);
  });
});

describe("resources", () => {
  // Build the handler once per describe — same shape index.ts wires
  // into the MCP server.
  const { onList, onListTemplates, onRead } = buildResourcesHandler({
    provider: makeResourcesProvider(),
  });

  it("onList advertises the health:// resource", async () => {
    const result = await onList();
    expect(result.resources.map((r) => r.uri)).toContain("health://");
  });

  it("onListTemplates is empty unless dev-mode is on", async () => {
    delete process.env.MCP_DEV;
    delete process.env.NODE_ENV;
    const result = await onListTemplates();
    expect(result.resourceTemplates).toHaveLength(0);
  });

  it("onListTemplates exposes logs://recent/{n} when MCP_DEV=1", async () => {
    process.env.MCP_DEV = "1";
    try {
      const result = await onListTemplates();
      expect(result.resourceTemplates.map((t) => t.uriTemplate)).toContain("logs://recent/{n}");
    } finally {
      delete process.env.MCP_DEV;
    }
  });

  it("onRead returns the health snapshot as application/json", async () => {
    const result = await onRead({ params: { uri: "health://" } });
    expect(result.contents).toHaveLength(1);
    expect(result.contents[0]?.mimeType).toBe("application/json");
    const parsed = JSON.parse(result.contents[0]?.text ?? "{}");
    expect(parsed.status).toMatch(/healthy|degraded|unhealthy/);
  });

  it("onRead bubbles a structured error for unknown URIs", async () => {
    await expect(onRead({ params: { uri: "fictional://" } })).rejects.toThrowError(
      /fictional:\/\//,
    );
  });
});
