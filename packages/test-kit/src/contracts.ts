/**
 * @george43g/test-kit/contracts — the per-app contract checks every MCP app in
 * this repo runs against ITSELF.
 *
 * WHY THESE ARE SHARED. browser-tab-mcp was the only app, so its contract tests
 * (the surface-coverage ledger, MCP↔CLI parity, tool annotations) each read
 * `makeAppRegistry()` from `../src` and were silent about any other app. A
 * second app got none of them, and nothing went red. Each app now runs the
 * same checks over its own registry and its own commander program, and
 * `apps/browser-tab-mcp/tests/app-admission.contract.test.ts` fails when an MCP
 * app is missing one.
 *
 * Every function here is pure and returns a list of problems (empty = holds).
 * The calling test does `expect(problems).toEqual([])`, so the message names
 * the app and the surface. No vitest import: the checks stay usable from a
 * fixture drill that expects them to FIND problems.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";

/** The slice of a commander `Command` these walkers read. */
export interface CommandLike {
  name(): string;
  aliases(): string[];
  readonly commands: readonly CommandLike[];
}

/**
 * Every command name commander knows: top-level names, their aliases, and
 * `parent sub` for one level of nesting. `withAliases: false` folds aliases
 * away (one entry per distinct command).
 */
export function cliCommandNames(program: CommandLike, withAliases = true): Set<string> {
  const names = new Set<string>();
  for (const cmd of program.commands) {
    names.add(cmd.name());
    if (withAliases) for (const alias of cmd.aliases()) names.add(alias);
    for (const sub of cmd.commands) names.add(`${cmd.name()} ${sub.name()}`);
  }
  return names;
}

/**
 * Every CLI command that is NOT the front of a registry tool. A container
 * command contributes its subcommands, never itself; commander's `help` is not
 * a surface; aliases fold into their command.
 */
export function cliOnlySurfaces(
  program: CommandLike,
  toolNames: readonly string[],
  cliFormOf: (tool: string) => string,
): Set<string> {
  const fronts = new Set(toolNames.map(cliFormOf));
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

// ── the surface-coverage ledger (docs/surfaces/effect-coverage.json) ─────────

export interface LedgerCoverage {
  tier: string;
  covers: string;
  evidence: string;
}
export interface LedgerRow {
  /** The app directory under `apps/` whose surface this row describes. */
  app: string;
  surface: string;
  kind: "tool" | "cli";
  coverage: LedgerCoverage[];
}
export interface Ledger {
  tiers: Record<string, string>;
  surfaces: LedgerRow[];
}

/**
 * The ledger's rows for one app agree with what that app actually exposes:
 * no gap, no orphan, no duplicate, the right kind, a declared tier, stated
 * evidence, and every non-pending evidence path present on disk.
 */
export function ledgerProblems(opts: {
  ledger: Ledger;
  /** App directory under `apps/`, e.g. "tmux-control-mcp". */
  app: string;
  toolNames: readonly string[];
  cliOnly: Iterable<string>;
  repoRoot: string;
}): string[] {
  const { ledger, app, toolNames, cliOnly, repoRoot } = opts;
  const problems: string[] = [];
  const rows = ledger.surfaces.filter((r) => r.app === app);
  const enumerated = new Map<string, "tool" | "cli">([
    ...toolNames.map((n) => [n, "tool"] as const),
    ...[...cliOnly].map((n) => [n, "cli"] as const),
  ]);
  const listed = rows.map((r) => r.surface);

  for (const s of enumerated.keys()) {
    if (!listed.includes(s)) {
      problems.push(
        `${app}: surface "${s}" has no ledger row. Add it to docs/surfaces/effect-coverage.json ` +
          `with "app": "${app}", the tier that will prove its EFFECT, and evidence "pending" ` +
          `until something does.`,
      );
    }
  }
  for (const s of listed) {
    if (!enumerated.has(s)) {
      problems.push(`${app}: ledger names surface "${s}", which ${app} no longer exposes.`);
    }
  }
  if (listed.length !== new Set(listed).size) {
    problems.push(`${app}: duplicate ledger rows among ${listed.join(", ")}.`);
  }

  const tiers = new Set(Object.keys(ledger.tiers));
  for (const row of rows) {
    const kind = enumerated.get(row.surface);
    if (kind && row.kind !== kind) {
      problems.push(`${app}: "${row.surface}" is a ${kind} surface, ledger says "${row.kind}".`);
    }
    if (row.coverage.length === 0) {
      problems.push(
        `${app}: "${row.surface}" has no coverage entry. If nothing will ever prove it, say so ` +
          "in `covers` and leave `evidence` pending rather than omitting the entry.",
      );
    }
    const seen = new Set<string>();
    for (const c of row.coverage) {
      if (!tiers.has(c.tier)) {
        problems.push(`${app}: "${row.surface}" claims unknown tier "${c.tier}".`);
      }
      if (seen.has(c.tier)) {
        problems.push(`${app}: "${row.surface}" has two "${c.tier}" entries — merge them.`);
      }
      seen.add(c.tier);
      if (c.covers.trim().length === 0) {
        problems.push(`${app}: "${row.surface}" (${c.tier}) has empty \`covers\`.`);
      }
      if (c.evidence.trim().length === 0) {
        problems.push(
          `${app}: "${row.surface}" (${c.tier}) has empty \`evidence\` — use "pending", which ` +
            "claims nothing, rather than an empty string, which looks like a claim.",
        );
      } else if (c.evidence !== "pending") {
        const path = resolve(repoRoot, c.evidence.split(":")[0] ?? "");
        if (!existsSync(path)) {
          problems.push(
            `${app}: "${row.surface}" (${c.tier}) cites "${c.evidence}", which does not exist.`,
          );
        }
      }
    }
  }
  return problems;
}

// ── MCP ↔ CLI parity ─────────────────────────────────────────────────────────

/**
 * Every tool is reachable from the CLI under `cliFormOf(tool)`, except the
 * ones in `exempt` — and every exemption must still be needed, so closing a
 * gap forces its exemption out rather than leaving a stale excuse behind.
 */
export function parityProblems(opts: {
  app: string;
  toolNames: readonly string[];
  cli: ReadonlySet<string>;
  cliFormOf: (tool: string) => string;
  /** tool → why it has no CLI front yet. */
  exempt?: Readonly<Record<string, string>>;
}): string[] {
  const { app, toolNames, cli, cliFormOf, exempt = {} } = opts;
  const problems: string[] = [];
  for (const tool of toolNames) {
    const form = cliFormOf(tool);
    const reachable = cli.has(form);
    if (!reachable && !(tool in exempt)) {
      problems.push(
        `${app}: tool "${tool}" has no CLI command ("${form}"). Every tool must be reachable ` +
          "from every surface — add the command, or map it if it is fronted under another name.",
      );
    }
    if (reachable && tool in exempt) {
      problems.push(`${app}: "${tool}" is reachable as "${form}" — delete its parity exemption.`);
    }
  }
  for (const tool of Object.keys(exempt)) {
    if (!toolNames.includes(tool)) {
      problems.push(`${app}: parity exemption for "${tool}", which is not a registered tool.`);
    }
  }
  return problems;
}

// ── tool annotations (MCP spec: title + four explicit hints) ─────────────────

export interface AnnotatedTool {
  name: string;
  annotations?:
    | {
        title?: string | undefined;
        readOnlyHint?: boolean | undefined;
        destructiveHint?: boolean | undefined;
        idempotentHint?: boolean | undefined;
        openWorldHint?: boolean | undefined;
      }
    | undefined;
}

const HINTS = ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const;

/**
 * Completeness (a non-empty title and all four hints explicit — the SDK
 * defaults skew permissive) and consistency (a read-only tool cannot claim
 * destructive updates).
 */
export function annotationProblems(app: string, tools: readonly AnnotatedTool[]): string[] {
  const problems: string[] = [];
  for (const def of tools) {
    const a = def.annotations;
    if (!a) {
      problems.push(`${app}: ${def.name} has no annotations`);
      continue;
    }
    if (typeof a.title !== "string" || a.title.length === 0) {
      problems.push(`${app}: ${def.name} has no annotations.title`);
    }
    for (const hint of HINTS) {
      if (typeof a[hint] !== "boolean") {
        problems.push(`${app}: ${def.name} leaves ${hint} to the SDK default`);
      }
    }
    if (a.readOnlyHint === true && a.destructiveHint !== false) {
      problems.push(`${app}: ${def.name} is read-only yet does not set destructiveHint:false`);
    }
  }
  return problems;
}

// ── README tool table ────────────────────────────────────────────────────────

/**
 * The README's `## Tools` table lists every registered tool and nothing else.
 * Rows are `| \`tool_name\` | …`; the table ends at the next `### ` or `## `.
 */
export function readmeToolTableProblems(
  app: string,
  readme: string,
  toolNames: readonly string[],
): string[] {
  const start = readme.indexOf("\n## Tools\n");
  if (start === -1) return [`${app}: README.md has no "## Tools" section`];
  const rest = readme.slice(start + 1);
  const end = rest.slice(3).search(/\n#{2,3} /);
  const table = end === -1 ? rest : rest.slice(0, end + 3);
  const listed = new Set([...table.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1] as string));
  const problems: string[] = [];
  for (const n of toolNames) {
    if (!listed.has(n)) problems.push(`${app}: tool "${n}" has no README row`);
  }
  for (const n of listed) {
    if (!toolNames.includes(n)) problems.push(`${app}: README row for "${n}", not a tool`);
  }
  return problems;
}
