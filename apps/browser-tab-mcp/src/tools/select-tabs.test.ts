/**
 * select_tabs registration — the recursive SelectorSchema must survive the
 * zod→JSON-schema conversion `toMcpTools()` performs for tools/list. The
 * stress harness caught the failure mode this pins: a schema the converter
 * chokes on doesn't break one tool, it empties the WHOLE catalog (case 1
 * "handshake + tools/list — 0 tools").
 */

import { describe, expect, it } from "vitest";
import { makeAppRegistry } from "./registry.js";

describe("select_tabs registration", () => {
  it("toMcpTools() renders the full catalog with select_tabs present", () => {
    const tools = makeAppRegistry().toMcpTools();
    expect(tools.length).toBeGreaterThanOrEqual(20);
    const st = tools.find((t) => t.name === "select_tabs");
    expect(st).toBeDefined();
  });

  it("the input schema is JSON-serializable and bounded", () => {
    const st = makeAppRegistry()
      .toMcpTools()
      .find((t) => t.name === "select_tabs");
    const text = JSON.stringify(st?.inputSchema);
    expect(text.length).toBeGreaterThan(100);
    // Recursive schema must resolve via $ref/$defs, not by infinite inlining;
    // 200KB is far beyond any sane rendering of ~17 node kinds.
    expect(text.length).toBeLessThan(200_000);
  });
});
