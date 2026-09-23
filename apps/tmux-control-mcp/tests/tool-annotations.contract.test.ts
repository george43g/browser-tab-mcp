/**
 * Every tmux-control tool carries a complete, consistent MCP ToolAnnotations
 * block: a title and all four hints explicit (the SDK defaults skew
 * permissive), and no read-only tool claiming destructive updates.
 */

import { annotationProblems } from "@george43g/test-kit/contracts";
import { describe, expect, it } from "vitest";
import { makeAppRegistry } from "../src/tools/registry.js";

const tools = makeAppRegistry().tools;

describe("tool annotations contract (tmux-control)", () => {
  it("reads a non-empty registry", () => {
    expect(tools.length).toBeGreaterThan(0);
  });

  it("every tool declares a title and all four hints, consistently", () => {
    expect(annotationProblems("tmux-control-mcp", tools)).toEqual([]);
  });
});
