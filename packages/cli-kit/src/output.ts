/**
 * Output mode switch.
 *
 * Every CLI subcommand should produce *either* a human-readable form
 * (tables, colors, multi-line) or a machine-readable JSON blob, based on:
 *   1. `--json` flag (explicit)
 *   2. stdout is not a TTY (implicit — being piped)
 *   3. `CI=true` (implicit — automation)
 *
 * The default is human form when stdout is a TTY, JSON otherwise.
 */

import Table from "cli-table3";
import { isCI, isStdoutTTY } from "./tty.js";

export type OutputMode = "human" | "json";

export interface OutputFlags {
  json?: boolean;
  noColor?: boolean;
  quiet?: boolean;
}

export function resolveOutputMode(flags: OutputFlags = {}): OutputMode {
  if (flags.json) return "json";
  if (!isStdoutTTY() || isCI()) return "json";
  return "human";
}

export interface TableSpec<T> {
  head: string[];
  rows: (item: T) => Array<string | number>;
}

export function printTable<T>(items: T[], spec: TableSpec<T>): void {
  if (items.length === 0) {
    process.stdout.write("(no results)\n");
    return;
  }
  const table = new Table({ head: spec.head, style: { head: ["cyan"] } });
  for (const item of items) {
    table.push(spec.rows(item) as string[]);
  }
  process.stdout.write(`${table.toString()}\n`);
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Print either a JSON blob or a human-rendered table based on resolved mode.
 * The most common use case for CLI subcommands.
 */
export function printAuto<T>(items: T[], spec: TableSpec<T>, flags?: OutputFlags): void {
  if (resolveOutputMode(flags) === "json") {
    printJson(items);
  } else {
    printTable(items, spec);
  }
}
