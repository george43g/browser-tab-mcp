/**
 * Typed predicate evaluation over a domain field catalog (spec §7.5).
 *
 * The package owns the OPERATORS; the domain owns the FIELDS. Operator/type
 * compatibility is validated before resolution (validate.ts) so a `prefix`
 * over a number field is a schema-adjacent error, not a silent false.
 *
 * Unknown values: a leaf whose field read returns undefined/null resolves per
 * the where-node policy (spec §24.6) — "exclude" fails the MEMBER (the leaf
 * evaluates false, and `not` of an unknown leaf is also false: absence of
 * evidence never becomes evidence), "error" rejects the resolution. The
 * three-valued logic this implies is deliberately conservative and documented
 * in the README; an "include" policy is deferred until a real caller needs it.
 */

import type { FieldType, SelectionDomain } from "./domain.js";
import { fail } from "./errors.js";
import type { Predicate } from "./schema.js";

/** Operators legal per declared field type. */
export const OPS_BY_TYPE: Record<FieldType, readonly string[]> = {
  string: ["eq", "ne", "lt", "le", "gt", "ge", "contains", "prefix", "suffix", "glob", "regex"],
  number: ["eq", "ne", "lt", "le", "gt", "ge"],
  boolean: ["eq", "ne"],
};

/** Convert a glob (only `*` and `?` are wildcards) to an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`);
}

/** Three-valued leaf outcome: unknown propagates so NOT can stay conservative. */
type Tri = true | false | "unknown";

function evalLeaf<Ref>(domain: SelectionDomain<Ref>, ref: Ref, pred: Predicate, path: string): Tri {
  switch (pred.kind) {
    case "exists": {
      const v = domain.readField(ref, pred.field);
      return v !== undefined && v !== null;
    }
    case "inSet": {
      const v = domain.readField(ref, pred.field);
      if (v === undefined || v === null) return "unknown";
      return pred.values.includes(v as string | number);
    }
    case "cmp": {
      const v = domain.readField(ref, pred.field);
      if (v === undefined || v === null) return "unknown";
      const { op, value } = pred;
      switch (op) {
        case "eq":
          return v === value;
        case "ne":
          return v !== value;
        case "lt":
          return (v as number | string) < (value as number | string);
        case "le":
          return (v as number | string) <= (value as number | string);
        case "gt":
          return (v as number | string) > (value as number | string);
        case "ge":
          return (v as number | string) >= (value as number | string);
        case "contains":
          return String(v).includes(String(value));
        case "prefix":
          return String(v).startsWith(String(value));
        case "suffix":
          return String(v).endsWith(String(value));
        case "glob":
          return globToRegExp(String(value)).test(String(v));
        case "regex": {
          let re: RegExp;
          try {
            re = new RegExp(String(value));
          } catch {
            fail(
              "E_INVALID_REGEX",
              path,
              `regex ${JSON.stringify(String(value))} failed to compile`,
              "supply a valid ECMAScript regular expression",
            );
          }
          return re.test(String(v));
        }
      }
      // Exhaustive switch above; unreachable.
      return "unknown";
    }
    default:
      return "unknown"; // combinators handled by evalPredicate
  }
}

function evalTri<Ref>(domain: SelectionDomain<Ref>, ref: Ref, pred: Predicate, path: string): Tri {
  switch (pred.kind) {
    case "and": {
      let sawUnknown = false;
      for (const [i, p] of pred.predicates.entries()) {
        const r = evalTri(domain, ref, p, `${path}.predicates[${i}]`);
        if (r === false) return false;
        if (r === "unknown") sawUnknown = true;
      }
      return sawUnknown ? "unknown" : true;
    }
    case "or": {
      let sawUnknown = false;
      for (const [i, p] of pred.predicates.entries()) {
        const r = evalTri(domain, ref, p, `${path}.predicates[${i}]`);
        if (r === true) return true;
        if (r === "unknown") sawUnknown = true;
      }
      return sawUnknown ? "unknown" : false;
    }
    case "not": {
      const r = evalTri(domain, ref, pred.predicate, `${path}.predicate`);
      return r === "unknown" ? "unknown" : !r;
    }
    default:
      return evalLeaf(domain, ref, pred, path);
  }
}

/**
 * Evaluate a predicate for one member under a where-node unknown policy.
 * Returns whether the member passes the filter.
 */
export function evalPredicate<Ref>(
  domain: SelectionDomain<Ref>,
  ref: Ref,
  pred: Predicate,
  unknownPolicy: "exclude" | "error",
  path: string,
): boolean {
  const r = evalTri(domain, ref, pred, path);
  if (r === "unknown") {
    if (unknownPolicy === "error") {
      fail(
        "E_UNKNOWN_FIELD_VALUE",
        path,
        `a field read returned no value for member "${domain.stableKey(ref)}" and unknown:"error" is set`,
        'use unknown:"exclude" to drop such members instead',
      );
    }
    return false;
  }
  return r;
}
