/**
 * Build a Commander program with the starter's global flags wired up:
 *   --json        machine-readable output
 *   -q, --quiet   suppress non-error output
 *   -v, --verbose debug-level logging
 *   --no-color    disable colors
 *
 * Use as the foundation for any tool's `browser-tab-cli` bin.
 */

import { Command } from "commander";

export interface ProgramOptions {
  name: string;
  description: string;
  version: string;
}

export function buildProgram(opts: ProgramOptions): Command {
  const program = new Command();
  program
    .name(opts.name)
    .description(opts.description)
    .version(opts.version, "-V, --version")
    .option("--json", "Emit machine-readable JSON (where supported by the subcommand)")
    .option("-q, --quiet", "Suppress non-error output to stderr")
    .option("-v, --verbose", "Log debug-level information to stderr")
    .option("--no-color", "Disable color output");
  return program;
}
