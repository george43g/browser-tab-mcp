/**
 * Env-var ↔ CLI flag binder.
 *
 * The starter template's brief: "every env var is also accepted as a CLI flag".
 * This module is the registry — declare a binding once, get a commander
 * option registered, plus an `applyEnvFromFlags()` helper that writes the
 * resolved value back to `process.env` so downstream code reading env vars
 * picks it up.
 *
 * Convention:
 *   envVar:  STARTER_LOG_DIR        flag:  --log-dir
 *   envVar:  STARTER_HTTP_TOKEN     flag:  --http-token
 *   envVar:  MCP_MAX_RSS_MB         flag:  --max-rss-mb
 *
 * The flag name is derived by lowercasing, replacing `_` with `-`, and
 * dropping the prefix (e.g. STARTER_). Pass `prefix` to control which prefix
 * is stripped.
 */

import type { Command } from "commander";

export interface EnvFlagBinding {
  /** Env var name, e.g. STARTER_LOG_DIR. */
  envVar: string;
  /** Short description for `--help` output. */
  description: string;
  /** Default value (also used as commander's documented default). */
  defaultValue?: string;
  /** If true, the binding is boolean (presence sets "1", absence does nothing). */
  boolean?: boolean;
}

export interface BinderOptions {
  /**
   * Prefix to strip when deriving the flag name. The first matching prefix
   * is stripped. Defaults to ["MCP_"] so robustness knobs get short flags;
   * pass your tool's prefix (e.g. ["FOO_MCP_", "MCP_"]) when wiring up.
   */
  stripPrefixes?: string[];
}

function envToFlag(envVar: string, stripPrefixes: string[]): string {
  let name = envVar;
  for (const p of stripPrefixes) {
    if (name.startsWith(p)) {
      name = name.slice(p.length);
      break;
    }
  }
  return `--${name.toLowerCase().replace(/_/g, "-")}`;
}

/**
 * Register a list of bindings as commander options on the given program.
 * Returns the same program for chaining.
 */
export function bindEnvFlags(
  program: Command,
  bindings: EnvFlagBinding[],
  opts: BinderOptions = {},
): Command {
  const stripPrefixes = opts.stripPrefixes ?? ["MCP_"];
  for (const b of bindings) {
    const flag = envToFlag(b.envVar, stripPrefixes);
    if (b.boolean) {
      program.option(flag, b.description);
    } else {
      const optStr = `${flag} <value>`;
      if (b.defaultValue !== undefined) {
        program.option(optStr, b.description, b.defaultValue);
      } else {
        program.option(optStr, b.description);
      }
    }
  }
  return program;
}

/**
 * After commander has parsed argv, copy resolved values from the parsed
 * options back into process.env. Subsequent reads via envNum/envStr/envBool
 * see the user's CLI flags.
 *
 * Resolution: CLI flag (if set) wins over existing process.env (so flags
 * always take precedence). Otherwise no-op.
 */
export function applyEnvFromFlags(
  program: Command,
  bindings: EnvFlagBinding[],
  opts: BinderOptions = {},
): void {
  const stripPrefixes = opts.stripPrefixes ?? ["MCP_"];
  const parsed = program.opts<Record<string, unknown>>();
  for (const b of bindings) {
    const flag = envToFlag(b.envVar, stripPrefixes);
    const key = flag.slice(2).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
    const value = parsed[key];
    if (value === undefined) continue;
    if (b.boolean) {
      process.env[b.envVar] = value ? "1" : "0";
    } else if (typeof value === "string" && value.length > 0) {
      process.env[b.envVar] = value;
    }
  }
}
