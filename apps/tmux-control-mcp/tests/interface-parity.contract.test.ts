/**
 * Every tmux-control tool is reachable from its CLI, asserted by driving
 * commander (`buildProgram()`), not by grepping `cli.ts`.
 */

import { parityProblems } from "@george43g/test-kit/contracts";
import { describe, expect, it } from "vitest";
import { makeAppRegistry } from "../src/tools/registry.js";
import { cliCommandNames, cliFormOf } from "./helpers/cli-surface.js";

/**
 * Known gaps, each with its reason. The check fails if an exemption is no
 * longer needed, so closing a gap removes its line here.
 */
const EXEMPT: Readonly<Record<string, string>> = {
  get_logs:
    "scaffolded by mcp-scaffold with no CLI front (browser-tab fronts it as `logs`); " +
    "tmux-control's real surface arrives in Phase 3",
};

describe("MCP ↔ CLI parity (tmux-control)", () => {
  const toolNames = makeAppRegistry().tools.map((t) => t.name);

  it("reads a non-empty registry", () => {
    expect(toolNames.length).toBeGreaterThan(0);
  });

  it("fronts every tool with a CLI command", () => {
    expect(
      parityProblems({
        app: "tmux-control-mcp",
        toolNames,
        cli: cliCommandNames(),
        cliFormOf,
        exempt: EXEMPT,
      }),
    ).toEqual([]);
  });
});
