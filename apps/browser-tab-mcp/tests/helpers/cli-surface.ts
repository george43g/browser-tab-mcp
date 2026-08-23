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
