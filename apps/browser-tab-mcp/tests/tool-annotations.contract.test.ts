/**
 * Tool-annotation contract — every tool the registry exposes must carry a
 * complete, internally consistent MCP ToolAnnotations block (spec §26.2:
 * "every tool must have a title and truthful readOnlyHint, destructiveHint,
 * idempotentHint, and openWorldHint").
 *
 * The tool set is enumerated from `makeAppRegistry()`, never hand-listed, so
 * tool #21 is bound by this contract the moment it registers (the same rule
 * surface-coverage.contract.test.ts follows). The enumeration itself is
 * asserted non-empty — a selector that matches nothing must fail, not
 * vacuously pass (the partition-vs-iterate rule).
 *
 * Truthfulness of an individual hint cannot be proven by a test; what CAN be
 * pinned is completeness (no hint left to the SDK's defaults, which skew
 * permissive: destructiveHint defaults TRUE, openWorldHint defaults TRUE) and
 * consistency (a read-only tool claiming destructive updates is a
 * contradiction under the MCP spec, where destructiveHint is only meaningful
 * when readOnlyHint is false).
 */

import { describe, expect, it } from "vitest";
import { makeAppRegistry } from "../src/tools/registry.js";

const tools = makeAppRegistry().tools;

describe("tool annotations contract", () => {
  it("enumerates a non-trivial tool set (selector sanity)", () => {
    expect(tools.length).toBeGreaterThanOrEqual(20);
  });

  it("every tool declares all four hints explicitly plus a non-empty title", () => {
    for (const def of tools) {
      const a = def.annotations;
      expect(a, `${def.name} has no annotations`).toBeDefined();
      expect(typeof a.title, `${def.name} missing annotations.title`).toBe("string");
      expect((a.title ?? "").length, `${def.name} has an empty title`).toBeGreaterThan(0);
      for (const hint of [
        "readOnlyHint",
        "destructiveHint",
        "idempotentHint",
        "openWorldHint",
      ] as const) {
        expect(typeof a[hint], `${def.name} leaves ${hint} to the SDK default`).toBe("boolean");
      }
    }
  });

  it("no read-only tool claims destructive updates", () => {
    for (const def of tools.filter((d) => d.annotations.readOnlyHint === true)) {
      expect(
        def.annotations.destructiveHint,
        `${def.name} is read-only yet sets destructiveHint`,
      ).toBe(false);
    }
  });

  it("read-only tools exist and include the known-safe reads (filter sanity)", () => {
    // Guards the filter in the previous test: if readOnlyHint parsing broke
    // and the filter matched nothing, that test would pass vacuously.
    const readOnly = tools.filter((d) => d.annotations.readOnlyHint === true).map((d) => d.name);
    expect(readOnly).toEqual(expect.arrayContaining(["list_tabs", "health_check", "journal"]));
  });

  it("the destructive set is exactly the tools that can irreversibly lose user state", () => {
    const destructive = tools
      .filter((d) => d.annotations.destructiveHint === true)
      .map((d) => d.name)
      .sort();
    // close_* delete tabs/windows; bookmarks.remove deletes whole subtrees;
    // tab_action navigate/discard irreversibly lose in-page state;
    // apply_destructive_plan does the same across a whole selection (Phase 5
    // PR-N) and is a SEPARATE tool from apply_tab_layout precisely so this
    // list stays true — a confirmDestruction flag on the safe tool would have
    // left it annotated non-destructive while doing this. Growing this set is
    // a deliberate act — update the expectation WITH the reason in the tool's
    // own annotations comment.
    expect(destructive).toEqual([
      "apply_destructive_plan",
      "bookmarks",
      "close_tab",
      "close_window",
      "cut_tabs",
      "tab_action",
    ]);
  });
});
