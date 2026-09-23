/**
 * tmux-control's CLI surface, enumerated from commander via `buildProgram()` —
 * never grepped. Shared by the parity and surface-coverage contracts so the
 * one hand-written piece, the tool → CLI-command naming map, has one copy.
 */

import {
  cliOnlySurfaces as cliOnlyOf,
  cliCommandNames as commandNamesOf,
} from "@george43g/test-kit/contracts";
import { buildProgram } from "../../src/cli.js";

/** tool name → the CLI command that fronts it, where the two differ. */
export const TOOL_CLI_FORM: Readonly<Record<string, string>> = {
  health_check: "health",
};

export function cliFormOf(tool: string): string {
  return TOOL_CLI_FORM[tool] ?? tool;
}

export function cliCommandNames(): Set<string> {
  return commandNamesOf(buildProgram());
}

export function cliOnlySurfaces(toolNames: readonly string[]): Set<string> {
  return cliOnlyOf(buildProgram(), toolNames, cliFormOf);
}
