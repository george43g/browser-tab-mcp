/**
 * Every tool must be reachable from every surface.
 *
 * THE RULE (George, 2026-08-18): "the general rule is that most features should
 * be available to all types of interfaces or api surfaces." This repo has three
 * — MCP (`tools/list`), the CLI (`browser-tab <cmd>`), and the TUI — plus the
 * REPL, which shares the CLI's dispatcher and therefore inherits parity for
 * free.
 *
 * The MCP registry is the source of truth, because that is where a tool is
 * DEFINED. A new tool added there and not surfaced in the CLI is invisible to
 * every scripted consumer, and nothing about the code would look wrong — which
 * is exactly how `get_logs` sat with no CLI equivalent.
 *
 * The CLI is asserted by DRIVING COMMANDER, not by grepping `cli.ts`. A regex
 * over the source would pass on a command that is registered but throws, and
 * would need updating for any refactor of how commands are declared.
 */

import { describe, expect, it } from "vitest";
import { makeAppRegistry } from "../src/tools/registry.js";
import { cliCommandNames, cliFormOf, TOOL_CLI_FORM } from "./helpers/cli-surface.js";

// The tool → CLI-command mapping used to live here. It moved to
// `helpers/cli-surface.ts` when the surface-coverage ledger became a second
// reader of it: two copies of a naming map drift, and the drift shows up as a
// PASSING test in both files.

describe("MCP ↔ CLI parity", () => {
  const tools = makeAppRegistry().tools.map((t) => t.name);
  const cli = cliCommandNames();

  it("registers a non-trivial number of tools (canary on the registry read)", () => {
    // If `list()` ever returned [], every parity assertion below would pass
    // vacuously — which is the failure mode of a test like this.
    expect(tools.length).toBeGreaterThan(10);
  });

  it.each(
    makeAppRegistry()
      .tools.map((t) => t.name)
      .filter((n) => n !== "noop"),
  )("%s is reachable from the CLI", (tool) => {
    const expected = cliFormOf(tool);
    expect(
      cli.has(expected),
      `tool "${tool}" has no CLI command ("${expected}"). Every tool must be reachable ` +
        `from every surface — add the command in cli.ts, or map it in TOOL_CLI_FORM ` +
        `(tests/helpers/cli-surface.ts) if it is fronted under a different name.`,
    ).toBe(true);
  });

  it("exposes get_logs on the CLI, gated by the dispatcher rather than by hiding", () => {
    // The specific gap this test was written for. `logs` is registered
    // unconditionally: hiding a command from --help never disabled it, and it
    // would make the generated usage artifacts depend on the environment.
    expect(cli.has("logs")).toBe(true);
  });

  it("has no CLI command fronting a tool that does not exist", () => {
    // The other direction: a command left behind after a tool was removed
    // would fail at runtime with "Unknown tool name" and look like a bug.
    const known = new Set([
      ...tools,
      ...Object.values(TOOL_CLI_FORM),
      // Surfaces and lifecycle, not tool fronts.
      "mcp",
      "tui",
      "doctor",
      "daemon",
      "repl",
      "console",
      "window",
      "help",
      "reload-extension",
      "annotate",
      "screenshot",
      "journal",
      "history",
      // Aliases of a real command, like `console` above: commander reports
      // them as names, so they are reachable but front nothing of their own.
      "bm",
    ]);
    const orphans = [...cli].filter((c) => !c.includes(" ") && !known.has(c));
    expect(orphans).toEqual([]);
  });
});

describe("TUI parity", () => {
  it("offers the tab actions the tool supports", async () => {
    // The TUI cannot mirror every tool (journal/history/screenshot are not
    // interactive-list concepts), but the per-tab WRITE actions are exactly
    // what a tab manager is for — and it previously had only focus/close/move.
    const { TAB_ACTIONS } = await import("../src/tui/actions.js");
    const offered = new Set(TAB_ACTIONS.map((a) => a.action));
    for (const kind of ["mute", "unmute", "pin", "unpin", "discard", "reload", "duplicate"]) {
      expect(offered.has(kind), `TUI action menu is missing "${kind}"`).toBe(true);
    }
  });
});
