/**
 * Binding conformance suite: what "a correct SelectionDomain" means, as a
 * checkable claim rather than "it compiles" (tmux-control plan §2/§4 M1).
 *
 * `runDomainConformance(domain, expectations)` checks two things against one
 * snapshot view:
 *
 * 1. BINDING INVARIANTS — the contract `domain.ts` states and `resolve.ts`
 *    silently relies on (dedupe by stable key, kind-homogeneous sequences,
 *    "the anchor is in its own sibling sequence", `between`'s shared-parent
 *    test standing in for a shared sibling sequence, …). Each has a stable id
 *    in `INVARIANTS`, so a failure names the rule it broke.
 * 2. RESOLUTION CASES — per-node-kind expectations the CALLER supplies,
 *    because only the binding's author knows what its snapshot should yield.
 *    Coverage is enforced: every node kind in a group being run must be the
 *    root of at least one case, so a kind cannot be skipped by omission.
 *
 * NODE-KIND GROUPS. Of the 17 node kinds, four read the sibling view
 * (`parentOf`/`siblingsOf`) — `offset expand between siblings`; the other 13
 * need only scopes, relations, `orderedMembers`, `byKey` and `readField`.
 * The split is what lets a graph-shaped binding (tmux, where a linked window
 * has more than one sibling sequence) prove the 13 before the identity
 * question is settled. It is ENFORCED, not asserted: a `siblingFree` run
 * resolves every case against a proxy whose `parentOf`/`siblingsOf` throw,
 * skips the sibling-view invariants, and rejects a case whose tree contains a
 * sibling-dependent node anywhere (a `withinEach` wrapping an `offset` is a
 * sibling-dependent case).
 *
 * RUNNER-AGNOSTIC, on purpose. The suite returns a report and imports no
 * test framework: the inversion tests have to assert WHICH invariant failed,
 * which a report makes a plain equality and a thrown `expect` makes a regex
 * over prose; and the report is equally usable from a sweep script or a
 * binding's own CLI self-check. Callers in vitest assert
 * `expect(report.failures).toEqual([])`, which prints every failure at once.
 *
 * It is exported from the `./conformance` subpath, not the package root: it
 * is test infrastructure, and the root entry is what ships inside the bin.
 */

import type { ResolvedSelection, SelectionDomain } from "./domain.js";
import { ControlLanguageError, type ErrorCode } from "./errors.js";
import { resolveSelector } from "./resolve.js";
import type { Selector } from "./schema.js";
import { parseSelector, validateSelector } from "./validate.js";

export type NodeKind = Selector["kind"];

/** The 13 node kinds that resolve without the sibling view (plan §2). */
export const SIBLING_FREE_KINDS = [
  "ids",
  "scope",
  "members",
  "positions",
  "where",
  "union",
  "intersect",
  "subtract",
  "complement",
  "sort",
  "slice",
  "withinEach",
  "flatten",
] as const satisfies readonly NodeKind[];

/** The four node kinds that call `siblingsOf` (and, for `between`, `parentOf`). */
export const SIBLING_DEPENDENT_KINDS = [
  "offset",
  "expand",
  "between",
  "siblings",
] as const satisfies readonly NodeKind[];

export type NodeGroup = "siblingFree" | "siblingDependent";

/**
 * Invariant ids → the rule, in one sentence. `view: "sibling"` marks the ones
 * only the sibling-dependent group needs; the rest always run.
 */
export const INVARIANTS = {
  "declarations-stable": {
    view: "core",
    rule: "scopes(), relations() and fields() answer the same entries on every call",
  },
  "scope-kind": {
    view: "core",
    rule: "every member of a scope has the kind scopes() declares for it",
  },
  "relation-kind": {
    view: "core",
    rule: "every member of orderedMembers(p, R) has the kind relations() declares for R",
  },
  "relation-applies-by-kind": {
    view: "core",
    rule: "whether a relation applies (defined vs undefined) depends only on the parent's kind",
  },
  "sequence-unique": {
    view: "core",
    rule: "no stable key appears twice in one ordered sequence",
  },
  "key-stable": {
    view: "core",
    rule: "stableKey(ref) answers the same key on every call",
  },
  "key-unique": {
    view: "core",
    rule: "refs sharing a stable key are one entity: same kind and same value for every declared field",
  },
  "key-roundtrip": {
    view: "core",
    rule: "byKey(stableKey(ref)) returns a ref with the same key and kind",
  },
  "key-absent": {
    view: "core",
    rule: "byKey answers undefined for a key the snapshot does not contain",
  },
  "order-stable": {
    view: "core",
    rule: "scopeMembers, orderedMembers and siblingsOf return the same key order on every call",
  },
  "field-type": {
    view: "core",
    rule: "readField returns undefined or a value of the field's declared type (numbers are not NaN)",
  },
  "field-stable": {
    view: "core",
    rule: "readField answers the same value on every call",
  },
  "field-coverage": {
    view: "core",
    rule: "every declared field is defined on at least one entity, unless listed in sparseFields",
  },
  "universe-bounded": {
    view: "core",
    rule: "the reachable entity set is finite (at most maxEntities)",
  },
  "sibling-contains-self": {
    view: "sibling",
    rule: "siblingsOf(ref) contains ref",
  },
  "sibling-kind": {
    view: "sibling",
    rule: "every sibling of ref has ref's kind",
  },
  "sibling-class": {
    view: "sibling",
    rule: "every sibling of ref has the same sibling sequence and the same parent as ref",
  },
  "parent-children": {
    view: "sibling",
    rule: "siblingsOf(ref) equals orderedMembers(parentOf(ref), R) for some declared relation R",
  },
  "parent-determines-siblings": {
    view: "sibling",
    rule: "two refs of one kind with the same parent (or both parentless) share one sibling sequence — `between` relies on it",
  },
} as const satisfies Record<string, { view: "core" | "sibling"; rule: string }>;

export type InvariantId = keyof typeof INVARIANTS;

/** What a resolution case must produce. */
export type CaseExpectation =
  | {
      /** Ordered stable keys of the result. */
      keys: readonly string[];
      /** Result kind; checked when given (an empty result's kind is still meaningful). */
      kind?: string;
      /** Per-occurrence branchPath, checked when given. */
      branchPaths?: readonly (readonly string[])[];
      /** Number of warnings, checked when given. */
      warnings?: number;
    }
  | {
      /** The ControlLanguageError code resolution (or semantic validation) must raise. */
      error: ErrorCode;
    };

export interface ResolutionCase {
  /** Human-readable name; failures quote it. */
  name: string;
  selector: Selector;
  expect: CaseExpectation;
}

export interface ConformanceExpectations {
  /** Which node-kind groups to run. Default: both. */
  groups?: readonly NodeGroup[];
  /** Resolution cases. Each is filed under a group by the kinds in its tree. */
  cases: readonly ResolutionCase[];
  /** Declared fields allowed to read undefined on every entity of this snapshot. */
  sparseFields?: readonly string[];
  /** Cap on the reachable entity set (default 10 000). */
  maxEntities?: number;
}

export type ConformanceCheck =
  | InvariantId
  /** A case is not a valid selector, or its group was run without it. */
  | "case-invalid"
  /** A group being run has a node kind no case is rooted at. */
  | "case-coverage"
  /** A siblingFree case reached parentOf/siblingsOf. */
  | "sibling-view-used"
  /** A case's result differs from its expectation. */
  | "resolution"
  /** Resolving a case twice gave different results. */
  | "resolution-deterministic"
  /** A result violates the ResolvedSelection shape (ordinals, keys, dedupe, kind). */
  | "resolution-shape";

export interface ConformanceFailure {
  check: ConformanceCheck;
  /** What failed: a stable key, scope/relation/field name, or case name. */
  subject: string;
  message: string;
}

export interface ConformanceReport<Ref> {
  ok: boolean;
  failures: ConformanceFailure[];
  /** Groups actually run. */
  groups: NodeGroup[];
  /** Invariants actually checked. */
  invariants: InvariantId[];
  /** Case names run, per group. */
  cases: Record<NodeGroup, string[]>;
  /** Reachable entities the invariants were checked over. */
  entities: Ref[];
}

const SIBLING_DEPENDENT = new Set<string>(SIBLING_DEPENDENT_KINDS);
const ABSENT_KEY = "\u0000conformance:absent-key";

/** Direct child selectors of a node — exhaustive, so a new kind fails to compile here. */
function childSelectors(s: Selector): Selector[] {
  switch (s.kind) {
    case "ids":
    case "scope":
      return [];
    case "members":
      return [s.nodes];
    case "positions":
    case "where":
      return s.scope === undefined ? [] : [s.scope];
    case "offset":
      return [s.anchor];
    case "expand":
    case "siblings":
    case "sort":
    case "slice":
    case "flatten":
      return [s.selector];
    case "between":
      return [...s.anchors];
    case "union":
    case "intersect":
      return s.selectors;
    case "subtract":
      return [s.from, s.remove];
    case "complement":
      return [s.within, s.selector];
    case "withinEach":
      return [s.branches, s.select];
  }
}

/** Every node kind anywhere in a selector tree. */
export function nodeKindsIn(s: Selector, into = new Set<NodeKind>()): Set<NodeKind> {
  into.add(s.kind);
  for (const c of childSelectors(s)) nodeKindsIn(c, into);
  return into;
}

/** The group a case belongs to: sibling-dependent if ANY node in its tree is. */
export function groupOf(s: Selector): NodeGroup {
  for (const k of nodeKindsIn(s)) if (SIBLING_DEPENDENT.has(k)) return "siblingDependent";
  return "siblingFree";
}

class SiblingViewUsed extends Error {}

/**
 * The domain with its sibling view removed. Explicit delegation rather than a
 * spread, so a class-based binding's prototype methods survive.
 */
function withoutSiblingView<Ref>(d: SelectionDomain<Ref>): SelectionDomain<Ref> {
  return {
    kindOf: (r) => d.kindOf(r),
    stableKey: (r) => d.stableKey(r),
    byKey: (k) => d.byKey(k),
    scopes: () => d.scopes(),
    scopeMembers: (n) => d.scopeMembers(n),
    relations: () => d.relations(),
    orderedMembers: (p, r) => d.orderedMembers(p, r),
    parentOf: () => {
      throw new SiblingViewUsed("parentOf");
    },
    siblingsOf: () => {
      throw new SiblingViewUsed("siblingsOf");
    },
    fields: () => d.fields(),
    readField: (r, f) => d.readField(r, f),
  };
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

const showKeys = (ks: readonly string[]): string => `[${ks.join(", ")}]`;

const describeError = (e: unknown): string =>
  e instanceof ControlLanguageError
    ? `${e.code} at ${e.path}: ${e.message}`
    : `${e instanceof Error ? e.constructor.name : typeof e}: ${e instanceof Error ? e.message : String(e)}`;

/**
 * Run the conformance suite. Never throws for a non-conforming domain — every
 * violation is a `failures` entry; `ok` is `failures.length === 0`.
 */
export function runDomainConformance<Ref>(
  domain: SelectionDomain<Ref>,
  expectations: ConformanceExpectations,
): ConformanceReport<Ref> {
  const groups: NodeGroup[] = [...(expectations.groups ?? ["siblingFree", "siblingDependent"])];
  const siblingView = groups.includes("siblingDependent");
  const maxEntities = expectations.maxEntities ?? 10_000;
  const failures: ConformanceFailure[] = [];
  const fail = (check: ConformanceCheck, subject: string, message: string): void => {
    failures.push({ check, subject, message });
  };
  const invariants = (Object.keys(INVARIANTS) as InvariantId[]).filter(
    (id) => siblingView || INVARIANTS[id].view === "core",
  );

  const key = (r: Ref): string => domain.stableKey(r);
  const keysOfSeq = (seq: readonly Ref[]): string[] => seq.map(key);

  // ---- declarations ---------------------------------------------------------
  const scopes = domain.scopes();
  const relations = domain.relations();
  const fields = domain.fields();
  const sameEntries = <V>(a: ReadonlyMap<string, V>, b: ReadonlyMap<string, V>): boolean =>
    a.size === b.size && [...a].every(([k, v]) => b.has(k) && b.get(k) === v);
  for (const [name, a, b] of [
    ["scopes", scopes, domain.scopes()],
    ["relations", relations, domain.relations()],
    ["fields", fields, domain.fields()],
  ] as const) {
    if (!sameEntries<string>(a, b))
      fail("declarations-stable", name, `${name}() answered different entries on a second call`);
  }

  // ---- sequence checks shared by every ordered view -------------------------
  const checkSequence = (subject: string, seq: readonly Ref[], again: readonly Ref[]): void => {
    const ks = keysOfSeq(seq);
    const dup = ks.find((k, i) => ks.indexOf(k) !== i);
    if (dup !== undefined)
      fail("sequence-unique", subject, `key "${dup}" appears more than once in ${showKeys(ks)}`);
    const ks2 = keysOfSeq(again);
    if (!sameList(ks, ks2))
      fail("order-stable", subject, `first call ${showKeys(ks)}, second call ${showKeys(ks2)}`);
  };

  // ---- enumerate the reachable universe -------------------------------------
  // Scopes seed it; relations (and, with the sibling view, parents and
  // siblings) close it. Every distinct ref instance is kept, so two instances
  // sharing a key can be compared for key-unique.
  const seen = new Map<string, Ref[]>();
  const queue: Ref[] = [];
  let bounded = true;
  const visit = (r: Ref): void => {
    if (!bounded) return;
    const k = key(r);
    const list = seen.get(k);
    if (list === undefined) {
      if (seen.size >= maxEntities) {
        bounded = false;
        fail("universe-bounded", "universe", `more than ${maxEntities} reachable entities`);
        return;
      }
      seen.set(k, [r]);
      queue.push(r);
    } else if (!list.includes(r)) {
      list.push(r);
    }
  };

  for (const [name, kind] of scopes) {
    const members = domain.scopeMembers(name);
    checkSequence(`scope ${name}`, members, domain.scopeMembers(name));
    for (const m of members) {
      if (domain.kindOf(m) !== kind)
        fail(
          "scope-kind",
          `scope ${name}`,
          `member "${key(m)}" has kind "${domain.kindOf(m)}", scope declares "${kind}"`,
        );
      visit(m);
    }
  }

  // relation → kind → applies?  (first answer seen for that kind)
  const appliesByKind = new Map<string, Map<string, { applies: boolean; witness: string }>>();
  for (let i = 0; i < queue.length && bounded; i++) {
    const r = queue[i] as Ref;
    const k = key(r);
    const kind = domain.kindOf(r);
    for (const [rel, relKind] of relations) {
      const members = domain.orderedMembers(r, rel);
      const applies = members !== undefined;
      const byKind = appliesByKind.get(rel) ?? new Map();
      appliesByKind.set(rel, byKind);
      const first = byKind.get(kind);
      if (first === undefined) byKind.set(kind, { applies, witness: k });
      else if (first.applies !== applies)
        fail(
          "relation-applies-by-kind",
          `relation ${rel}`,
          `applies to "${first.witness}" (${first.applies}) but not equally to "${k}" (${applies}), both kind "${kind}"`,
        );
      if (members === undefined) continue;
      checkSequence(`${k} → ${rel}`, members, domain.orderedMembers(r, rel) ?? []);
      for (const m of members) {
        if (domain.kindOf(m) !== relKind)
          fail(
            "relation-kind",
            `${k} → ${rel}`,
            `member "${key(m)}" has kind "${domain.kindOf(m)}", relation declares "${relKind}"`,
          );
        visit(m);
      }
    }
    if (siblingView) {
      const p = domain.parentOf(r);
      if (p !== undefined) visit(p);
      for (const s of domain.siblingsOf(r)) visit(s);
    }
  }

  const entities = [...seen.values()].map((l) => l[0] as Ref);

  // ---- identity -------------------------------------------------------------
  const parentKey = (r: Ref): string | undefined => {
    const p = domain.parentOf(r);
    return p === undefined ? undefined : key(p);
  };
  for (const [k, instances] of seen) {
    const first = instances[0] as Ref;
    if (key(first) !== k)
      fail("key-stable", k, `stableKey answered "${key(first)}" on a second call`);
    const found = domain.byKey(k);
    if (found === undefined) fail("key-roundtrip", k, "byKey(stableKey(ref)) is undefined");
    else if (key(found) !== k || domain.kindOf(found) !== domain.kindOf(first))
      fail(
        "key-roundtrip",
        k,
        `byKey returned "${key(found)}" of kind "${domain.kindOf(found)}", expected kind "${domain.kindOf(first)}"`,
      );
    for (const other of [...instances.slice(1), ...(found === undefined ? [] : [found])]) {
      if (other === first) continue;
      const diffs: string[] = [];
      if (domain.kindOf(other) !== domain.kindOf(first))
        diffs.push(`kind ${domain.kindOf(first)} vs ${domain.kindOf(other)}`);
      for (const f of fields.keys()) {
        const a = domain.readField(first, f);
        const b = domain.readField(other, f);
        if (!Object.is(a, b)) diffs.push(`${f} ${String(a)} vs ${String(b)}`);
      }
      if (siblingView && parentKey(first) !== parentKey(other))
        diffs.push(`parent ${parentKey(first)} vs ${parentKey(other)}`);
      if (diffs.length > 0)
        fail("key-unique", k, `two different entities share this key (${diffs.join("; ")})`);
    }
  }
  if (!seen.has(ABSENT_KEY) && domain.byKey(ABSENT_KEY) !== undefined)
    fail("key-absent", ABSENT_KEY, "byKey answered an entity for a key no enumeration produced");

  // ---- fields ---------------------------------------------------------------
  const sparse = new Set(expectations.sparseFields ?? []);
  const defined = new Set<string>();
  for (const r of entities) {
    for (const [f, type] of fields) {
      const v = domain.readField(r, f);
      const again = domain.readField(r, f);
      if (!Object.is(v, again))
        fail("field-stable", `${key(r)}.${f}`, `read ${String(v)}, then ${String(again)}`);
      if (v === undefined || v === null) continue;
      defined.add(f);
      if (typeof v !== type || (type === "number" && Number.isNaN(v)))
        fail(
          "field-type",
          `${key(r)}.${f}`,
          `declared ${type}, read ${typeof v} ${JSON.stringify(v) ?? String(v)}`,
        );
    }
  }
  for (const f of fields.keys()) {
    if (!defined.has(f) && !sparse.has(f))
      fail(
        "field-coverage",
        f,
        "no reachable entity defines this field — a typo in the catalog, or add it to sparseFields",
      );
  }

  // ---- sibling view ---------------------------------------------------------
  if (siblingView) {
    const classOf = new Map<string, string>(); // `${kind}\u0000${parentKey}` → sibling keys
    for (const r of entities) {
      const k = key(r);
      const kind = domain.kindOf(r);
      const sibs = domain.siblingsOf(r);
      const sks = keysOfSeq(sibs);
      checkSequence(`${k} siblings`, sibs, domain.siblingsOf(r));
      if (!sks.includes(k))
        fail("sibling-contains-self", k, `siblingsOf answered ${showKeys(sks)}, without "${k}"`);
      const pk = parentKey(r);
      for (const s of sibs) {
        const sk = key(s);
        if (domain.kindOf(s) !== kind)
          fail("sibling-kind", k, `sibling "${sk}" has kind "${domain.kindOf(s)}", not "${kind}"`);
        if (sk === k) continue;
        const theirs = keysOfSeq(domain.siblingsOf(s));
        if (!sameList(sks, theirs))
          fail(
            "sibling-class",
            k,
            `sibling "${sk}" has siblings ${showKeys(theirs)}, "${k}" has ${showKeys(sks)}`,
          );
        if (parentKey(s) !== pk)
          fail("sibling-class", k, `sibling "${sk}" has parent ${parentKey(s)}, "${k}" has ${pk}`);
      }
      if (pk !== undefined) {
        const parent = domain.parentOf(r) as Ref;
        const views = [...relations.keys()].filter((rel) => {
          const m = domain.orderedMembers(parent, rel);
          return m !== undefined && sameList(keysOfSeq(m), sks);
        });
        if (views.length === 0)
          fail(
            "parent-children",
            k,
            `no relation of parent "${pk}" orders ${showKeys(sks)} — siblingsOf is not a view the parent exposes`,
          );
      }
      const cls = `${kind}\u0000${pk ?? "\u0000root"}`;
      const prior = classOf.get(cls);
      const joined = sks.join("\u0000");
      if (prior === undefined) classOf.set(cls, joined);
      else if (prior !== joined)
        fail(
          "parent-determines-siblings",
          k,
          `same kind "${kind}" and parent ${pk ?? "(none)"} as another entity, but a different sibling sequence ${showKeys(sks)} vs ${showKeys(prior.split("\u0000"))}`,
        );
    }
  }

  // ---- resolution cases -----------------------------------------------------
  const cases: Record<NodeGroup, string[]> = { siblingFree: [], siblingDependent: [] };
  const rootsByGroup: Record<NodeGroup, Set<NodeKind>> = {
    siblingFree: new Set(),
    siblingDependent: new Set(),
  };
  const guarded = withoutSiblingView(domain);
  for (const c of expectations.cases) {
    let selector: Selector;
    try {
      selector = parseSelector(c.selector);
    } catch (e) {
      fail("case-invalid", c.name, `not a valid selector: ${describeError(e)}`);
      continue;
    }
    const group = groupOf(selector);
    if (!groups.includes(group)) continue;
    cases[group].push(c.name);
    rootsByGroup[group].add(selector.kind);
    const target = group === "siblingFree" ? guarded : domain;

    const issues = validateSelector(selector, domain);
    const exp = c.expect;
    if ("error" in exp) {
      if (issues.some((i) => i.code === exp.error)) continue;
      try {
        const r = resolveSelector(selector, target);
        fail(
          "resolution",
          c.name,
          `expected ${exp.error}, resolved to ${showKeys(r.occurrences.map((o) => o.key))}`,
        );
      } catch (e) {
        if (e instanceof SiblingViewUsed)
          fail("sibling-view-used", c.name, `a siblingFree case called ${e.message}`);
        else if (!(e instanceof ControlLanguageError) || e.code !== exp.error)
          fail("resolution", c.name, `expected ${exp.error}, got ${describeError(e)}`);
      }
      continue;
    }
    if (issues.length > 0) {
      fail(
        "case-invalid",
        c.name,
        `semantic validation failed: ${issues.map((i) => `${i.code} at ${i.path}`).join("; ")}`,
      );
      continue;
    }
    let first: ResolvedSelection<Ref>;
    let second: ResolvedSelection<Ref>;
    try {
      first = resolveSelector(selector, target);
      second = resolveSelector(selector, target);
    } catch (e) {
      if (e instanceof SiblingViewUsed)
        fail("sibling-view-used", c.name, `a siblingFree case called ${e.message}`);
      else fail("resolution", c.name, `expected ${showKeys(exp.keys)}, got ${describeError(e)}`);
      continue;
    }
    const got = first.occurrences.map((o) => o.key);
    if (!sameList(got, exp.keys))
      fail("resolution", c.name, `expected ${showKeys(exp.keys)}, got ${showKeys(got)}`);
    if (exp.kind !== undefined && first.kind !== exp.kind)
      fail("resolution", c.name, `expected kind "${exp.kind}", got "${first.kind}"`);
    if (exp.warnings !== undefined && first.warnings.length !== exp.warnings)
      fail(
        "resolution",
        c.name,
        `expected ${exp.warnings} warning(s), got ${first.warnings.length}: ${first.warnings.join(" | ")}`,
      );
    if (exp.branchPaths !== undefined) {
      const bps = first.occurrences.map((o) => o.branchPath.join("/"));
      const want = exp.branchPaths.map((b) => b.join("/"));
      if (!sameList(bps, want))
        fail("resolution", c.name, `expected branchPaths ${showKeys(want)}, got ${showKeys(bps)}`);
    }
    if (
      !sameList(
        got,
        second.occurrences.map((o) => o.key),
      )
    )
      fail(
        "resolution-deterministic",
        c.name,
        "a second resolution ordered the result differently",
      );
    first.occurrences.forEach((o, i) => {
      if (o.ordinal !== i)
        fail("resolution-shape", c.name, `occurrence ${i} has ordinal ${o.ordinal}`);
      if (key(o.entity) !== o.key)
        fail("resolution-shape", c.name, `occurrence "${o.key}" wraps entity "${key(o.entity)}"`);
      if (domain.kindOf(o.entity) !== first.kind)
        fail(
          "resolution-shape",
          c.name,
          `occurrence "${o.key}" has kind "${domain.kindOf(o.entity)}", result kind "${first.kind}"`,
        );
    });
    if (new Set(got).size !== got.length)
      fail("resolution-shape", c.name, `result is not deduplicated: ${showKeys(got)}`);
  }

  const required: Record<NodeGroup, readonly NodeKind[]> = {
    siblingFree: SIBLING_FREE_KINDS,
    siblingDependent: SIBLING_DEPENDENT_KINDS,
  };
  for (const g of groups) {
    const missing = required[g].filter((k) => !rootsByGroup[g].has(k));
    if (missing.length > 0) fail("case-coverage", g, `no case is rooted at: ${missing.join(", ")}`);
  }

  return { ok: failures.length === 0, failures, groups, invariants, cases, entities };
}
