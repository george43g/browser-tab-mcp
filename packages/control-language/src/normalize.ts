/**
 * Normalization: a canonical structural form with identical semantics.
 *
 * Guaranteed law (property-tested): resolve(normalize(s)) ≡ resolve(s) for
 * every valid selector. Normalization is deliberately minimal — it exists so
 * two spellings of one intent compare equal, not to optimize:
 *
 * - defaults are made explicit (missing/bounds/inclusive/unknown/direction);
 * - nested same-op `union`/`intersect` operands are flattened one level at a
 *   time until fixed (safe: union is associative under left-biased order, and
 *   n-ary intersect is defined as first-operand order filtered by the rest);
 * - duplicate ids inside one `ids` list are removed, first occurrence wins;
 * - single-operand algebra nodes cannot exist (schema minimum is 2).
 */

import type { Predicate, Selector } from "./schema.js";

function normalizePredicate(p: Predicate): Predicate {
  switch (p.kind) {
    case "and":
    case "or":
      return { ...p, predicates: p.predicates.map(normalizePredicate) };
    case "not":
      return { ...p, predicate: normalizePredicate(p.predicate) };
    default:
      return p;
  }
}

export function normalizeSelector(s: Selector): Selector {
  switch (s.kind) {
    case "ids": {
      const ids = [...new Set(s.ids)];
      return { kind: "ids", ids, missing: s.missing ?? "error" };
    }
    case "scope":
      return s;
    case "members":
      return { ...s, nodes: normalizeSelector(s.nodes) };
    case "positions":
      return {
        ...s,
        scope: s.scope ? normalizeSelector(s.scope) : undefined,
        bounds: s.bounds ?? "clamp",
      };
    case "offset":
      return { ...s, anchor: normalizeSelector(s.anchor) };
    case "expand":
      return { ...s, selector: normalizeSelector(s.selector) };
    case "between":
      return {
        ...s,
        anchors: [normalizeSelector(s.anchors[0]), normalizeSelector(s.anchors[1])],
        inclusive: s.inclusive ?? true,
      };
    case "siblings":
      return { ...s, selector: normalizeSelector(s.selector) };
    case "where":
      return {
        ...s,
        scope: s.scope ? normalizeSelector(s.scope) : undefined,
        predicate: normalizePredicate(s.predicate),
        unknown: s.unknown ?? "exclude",
      };
    case "union":
    case "intersect": {
      const flat: Selector[] = [];
      for (const sub of s.selectors.map(normalizeSelector)) {
        if (sub.kind === s.kind) flat.push(...sub.selectors);
        else flat.push(sub);
      }
      return { kind: s.kind, selectors: flat };
    }
    case "subtract":
      return {
        kind: "subtract",
        from: normalizeSelector(s.from),
        remove: normalizeSelector(s.remove),
      };
    case "complement":
      return {
        kind: "complement",
        selector: normalizeSelector(s.selector),
        within: normalizeSelector(s.within),
      };
    case "sort":
      return {
        ...s,
        selector: normalizeSelector(s.selector),
        by: s.by.map((k) => ({ field: k.field, direction: k.direction ?? "asc" })),
      };
    case "slice":
      return { ...s, selector: normalizeSelector(s.selector), bounds: s.bounds ?? "clamp" };
    case "withinEach":
      return { ...s, branches: normalizeSelector(s.branches), select: normalizeSelector(s.select) };
    case "flatten":
      return { ...s, selector: normalizeSelector(s.selector) };
  }
}
