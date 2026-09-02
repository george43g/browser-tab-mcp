/**
 * The CLI's own account of what it exposes — enumerated, never hand-written.
 *
 * `buildProgram()` is exported from `src/cli.ts` precisely so the surface can
 * be INSPECTED rather than grepped (see its comment there). A regex over the
 * source would pass on a command that is registered but throws, and would need
 * rewriting for any refactor of how commands are declared.
 *
 * This lives in one place because three tests now depend on it agreeing with
 * itself: MCP↔CLI parity, the log-branding sweep, and the surface-coverage
 * ledger. A second copy would drift, and the drift would look like a passing
 * test — this repo's most-repeated failure mode.
 *
 * NOTE FOR CALLERS: `buildProgram()` runs commander registration in-process.
 * It is side-effect-free with respect to the logger (branding happens in
 * `main()`, not here — see the comment on `main`), but it is not free: prefer
 * one call per test file, hoisted, over one per assertion.
 */

import { buildProgram } from "../../src/cli.js";

/**
 * Every command name commander knows, including aliases and nested
 * subcommands (`window open`, `daemon status`, …).
 *
 * Aliases are included as first-class entries because commander reports an
 * alias as a name, and "registered" is not the same as "reachable" — `console`
 * (alias of `repl`) has to be driven to prove it resolves.
 */
export function cliCommandNames(): Set<string> {
  const program = buildProgram();
  const names = new Set<string>();
  for (const cmd of program.commands) {
    names.add(cmd.name());
    for (const alias of cmd.aliases()) names.add(alias);
    for (const sub of cmd.commands) names.add(`${cmd.name()} ${sub.name()}`);
  }
  return names;
}

/**
 * The same surface, minus aliases — one entry per distinct command.
 *
 * The branding sweep wants this: spawning `repl` and `console` both proves the
 * same prefix line, and long-running commands are the expensive ones to spawn.
 * Parity, by contrast, wants aliases included, which is why both exist.
 */
export function cliCommandNamesWithoutAliases(): Set<string> {
  const program = buildProgram();
  const names = new Set<string>();
  for (const cmd of program.commands) {
    names.add(cmd.name());
    for (const sub of cmd.commands) names.add(`${cmd.name()} ${sub.name()}`);
  }
  return names;
}

/**
 * The ONE hand-written mapping in this file: tool name → the CLI command that
 * fronts it, for every tool whose CLI form is not its own name.
 *
 * This cannot be derived — it is a naming decision, not a fact about the code.
 * Everything else below is computed from commander and the registry, so a
 * renamed or added command moves the enumeration on its own.
 *
 * It lives here rather than in a test file because two contract tests now read
 * it (MCP↔CLI parity and the surface-coverage ledger) and a second copy would
 * drift — this repo's most-repeated failure mode is an apparatus that passes
 * while proving nothing.
 */
export const TOOL_CLI_FORM: Readonly<Record<string, string>> = {
  health_check: "health",
  list_tabs: "list",
  focus_tab: "focus",
  move_tab: "move",
  open_tab: "open",
  close_tab: "close",
  tab_action: "act",
  group_tabs: "group",
  get_page: "page",
  select_tabs: "select",
  plan_tab_change: "plan",
  get_logs: "logs",
  bookmarks: "bookmark",
  // Subcommand forms — still fully reachable, just not the identity mapping.
  open_window: "window open",
  set_window: "window set",
  close_window: "window close",
  daemon_status: "daemon status",
};

/** The CLI command string that fronts a tool (identity when unmapped). */
export function cliFormOf(tool: string): string {
  return TOOL_CLI_FORM[tool] ?? tool;
}

/**
 * Every CLI command that is NOT the front of a registry tool.
 *
 * These are the surfaces the MCP registry cannot enumerate — process
 * lifecycle (`daemon run`), alternative entry points (`mcp`, `tui`, `repl`),
 * and the dev deploy loop (`reload-extension`). Together with the tools they
 * form the full command surface of this bin.
 *
 * Derived, not listed:
 *   - a container command (`window`, `daemon`) contributes its SUBCOMMANDS,
 *     never itself — `browser-tab window` alone does nothing;
 *   - commander's built-in `help` is not a surface of ours;
 *   - aliases are folded into their canonical command (we walk `name()`
 *     only), so `console` does not double-count against `repl`. The alias
 *     still has to be *driven* to prove it resolves — that is PR 11's job,
 *     and `cliCommandNames()` above is what exposes it.
 */
export function cliOnlySurfaces(toolNames: readonly string[]): Set<string> {
  const fronts = new Set(toolNames.map(cliFormOf));
  const program = buildProgram();
  const out = new Set<string>();
  for (const cmd of program.commands) {
    if (cmd.name() === "help") continue;
    if (cmd.commands.length > 0) {
      for (const sub of cmd.commands) {
        if (sub.name() === "help") continue;
        const surface = `${cmd.name()} ${sub.name()}`;
        if (!fronts.has(surface)) out.add(surface);
      }
      continue;
    }
    if (!fronts.has(cmd.name())) out.add(cmd.name());
  }
  return out;
}
