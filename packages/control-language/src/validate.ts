/**
 * Structural + semantic validation and complexity limits.
 *
 * Three layers, in order:
 *  1. `parseSelector` — Zod structural validation, issues mapped to the
 *     stable {path, code, message, hint} shape of spec §22.3.
 *  2. `analyzeComplexity` — documented limits (spec §22.1: recursive schemas
 *     have documented maximum depth, total-node, and list-length limits).
 *  3. `validateSelector` — semantic checks against a concrete domain:
 *     unknown scope/relation/field names, operator/type compatibility, and
 *     scope-required-outside-withinEach. Kind agreement (same-kind closure)
 *     is checked at resolve time, where every kind is actually known.
 */

import type { ZodIssue } from "zod";
import type { SelectionDomain } from "./domain.js";
import { ControlLanguageError, type Issue } from "./errors.js";
import { OPS_BY_TYPE } from "./predicate.js";
import type { Predicate, Selector } from "./schema.js";
import { SelectorSchema } from "./schema.js";

/** Documented complexity limits. Callers may lower them, never exceed hard caps. */
export interface Limits {
  /** Maximum selector nesting depth. Default 16. */
  maxDepth: number;
  /** Maximum total AST nodes (selector + predicate nodes). Default 256. */
  maxNodes: number;
  /** Maximum entries in any one list (ids, positions, operands, values). Default 1024. */
  maxListLength: number;
}

export const DEFAULT_LIMITS: Limits = { maxDepth: 16, maxNodes: 256, maxListLength: 1024 };

function zodIssueToIssue(i: ZodIssue): Issue {
  const path = i.path
    .map((p) => (typeof p === "number" ? `[${p}]` : `.${p}`))
    .join("")
    .replace(/^\./, "");
  return {
    path: path || "$",
    code: "E_SCHEMA",
    message: i.message,
    hint:
      i.code === "invalid_union_discriminator"
        ? "check the `kind` field against the documented node kinds"
        : undefined,
  };
}

/** Parse unknown input into a Selector, throwing an aggregate on failure. */
export function parseSelector(input: unknown): Selector {
  const r = SelectorSchema.safeParse(input);
  if (!r.success) {
    const issues = r.error.issues.map(zodIssueToIssue);
    throw new ControlLanguageError(issues[0] as Issue, issues);
  }
  return r.data;
}

interface Walk {
  nodes: number;
  issues: Issue[];
}

function walkPredicate(p: Predicate, path: string, depth: number, limits: Limits, w: Walk): void {
  w.nodes += 1;
  if (depth > limits.maxDepth) {
    w.issues.push({
      path,
      code: "E_COMPLEXITY",
      message: `predicate depth exceeds maxDepth ${limits.maxDepth}`,
      hint: "flatten nested and/or chains",
    });
    return;
  }
  switch (p.kind) {
    case "and":
    case "or":
      if (p.predicates.length > limits.maxListLength) {
        w.issues.push({
          path: `${path}.predicates`,
          code: "E_COMPLEXITY",
          message: `list exceeds maxListLength ${limits.maxListLength}`,
        });
      }
      for (const [i, sub] of p.predicates.entries())
        walkPredicate(sub, `${path}.predicates[${i}]`, depth + 1, limits, w);
      break;
    case "not":
      walkPredicate(p.predicate, `${path}.predicate`, depth + 1, limits, w);
      break;
    case "inSet":
      if (p.values.length > limits.maxListLength) {
        w.issues.push({
          path: `${path}.values`,
          code: "E_COMPLEXITY",
          message: `list exceeds maxListLength ${limits.maxListLength}`,
        });
      }
      break;
    default:
      break;
  }
}

function walkSelector(s: Selector, path: string, depth: number, limits: Limits, w: Walk): void {
  w.nodes += 1;
  if (depth > limits.maxDepth) {
    w.issues.push({
      path,
      code: "E_COMPLEXITY",
      message: `selector depth exceeds maxDepth ${limits.maxDepth}`,
      hint: "resolve a sub-selection first, or simplify the expression",
    });
    return;
  }
  const listCheck = (len: number, p: string) => {
    if (len > limits.maxListLength) {
      w.issues.push({
        path: p,
        code: "E_COMPLEXITY",
        message: `list exceeds maxListLength ${limits.maxListLength}`,
      });
    }
  };
  switch (s.kind) {
    case "ids":
      listCheck(s.ids.length, `${path}.ids`);
      break;
    case "scope":
      break;
    case "members":
      walkSelector(s.nodes, `${path}.nodes`, depth + 1, limits, w);
      break;
    case "positions":
      listCheck(s.positions.length, `${path}.positions`);
      if (s.scope) walkSelector(s.scope, `${path}.scope`, depth + 1, limits, w);
      break;
    case "offset":
      walkSelector(s.anchor, `${path}.anchor`, depth + 1, limits, w);
      break;
    case "expand":
    case "siblings":
    case "flatten":
      walkSelector(s.selector, `${path}.selector`, depth + 1, limits, w);
      break;
    case "between":
      walkSelector(s.anchors[0], `${path}.anchors[0]`, depth + 1, limits, w);
      walkSelector(s.anchors[1], `${path}.anchors[1]`, depth + 1, limits, w);
      break;
    case "where":
      if (s.scope) walkSelector(s.scope, `${path}.scope`, depth + 1, limits, w);
      walkPredicate(s.predicate, `${path}.predicate`, depth + 1, limits, w);
      break;
    case "union":
    case "intersect":
      listCheck(s.selectors.length, `${path}.selectors`);
      for (const [i, sub] of s.selectors.entries())
        walkSelector(sub, `${path}.selectors[${i}]`, depth + 1, limits, w);
      break;
    case "subtract":
      walkSelector(s.from, `${path}.from`, depth + 1, limits, w);
      walkSelector(s.remove, `${path}.remove`, depth + 1, limits, w);
      break;
    case "complement":
      walkSelector(s.selector, `${path}.selector`, depth + 1, limits, w);
      walkSelector(s.within, `${path}.within`, depth + 1, limits, w);
      break;
    case "sort":
      listCheck(s.by.length, `${path}.by`);
      walkSelector(s.selector, `${path}.selector`, depth + 1, limits, w);
      break;
    case "slice":
      walkSelector(s.selector, `${path}.selector`, depth + 1, limits, w);
      break;
    case "withinEach":
      walkSelector(s.branches, `${path}.branches`, depth + 1, limits, w);
      walkSelector(s.select, `${path}.select`, depth + 1, limits, w);
      break;
  }
}

/** Enforce complexity limits; throws an aggregate E_COMPLEXITY on violation. */
export function analyzeComplexity(
  selector: Selector,
  limits: Limits = DEFAULT_LIMITS,
): { nodes: number } {
  const w: Walk = { nodes: 0, issues: [] };
  walkSelector(selector, "$", 1, limits, w);
  if (w.nodes > limits.maxNodes) {
    w.issues.push({
      path: "$",
      code: "E_COMPLEXITY",
      message: `selector has ${w.nodes} nodes, exceeding maxNodes ${limits.maxNodes}`,
    });
  }
  if (w.issues.length > 0) throw new ControlLanguageError(w.issues[0] as Issue, w.issues);
  return { nodes: w.nodes };
}

function validatePredicate<Ref>(
  p: Predicate,
  domain: SelectionDomain<Ref>,
  path: string,
  issues: Issue[],
): void {
  const fields = domain.fields();
  const fieldNames = () => [...fields.keys()].join(", ");
  switch (p.kind) {
    case "and":
    case "or":
      for (const [i, sub] of p.predicates.entries())
        validatePredicate(sub, domain, `${path}.predicates[${i}]`, issues);
      break;
    case "not":
      validatePredicate(p.predicate, domain, `${path}.predicate`, issues);
      break;
    case "cmp": {
      const t = fields.get(p.field);
      if (!t) {
        issues.push({
          path: `${path}.field`,
          code: "E_UNKNOWN_FIELD",
          message: `field "${p.field}" is not in the domain's catalog`,
          hint: `declared fields: ${fieldNames()}`,
        });
        break;
      }
      if (!OPS_BY_TYPE[t].includes(p.op)) {
        issues.push({
          path: `${path}.op`,
          code: "E_OP_TYPE_MISMATCH",
          message: `operator "${p.op}" is not valid for ${t} field "${p.field}"`,
          hint: `valid operators for ${t}: ${OPS_BY_TYPE[t].join(", ")}`,
        });
      }
      break;
    }
    case "inSet":
    case "exists": {
      if (!fields.has(p.field)) {
        issues.push({
          path: `${path}.field`,
          code: "E_UNKNOWN_FIELD",
          message: `field "${p.field}" is not in the domain's catalog`,
          hint: `declared fields: ${fieldNames()}`,
        });
      }
      break;
    }
  }
}

/**
 * Semantic validation against a concrete domain. `inBranch` tracks whether a
 * scope-less leaf is legal (only inside withinEach's `select`).
 * Returns all issues rather than throwing, so a tool layer can render the
 * full list; `assertValid` is the throwing convenience.
 */
export function validateSelector<Ref>(
  selector: Selector,
  domain: SelectionDomain<Ref>,
  path = "$",
  inBranch = false,
): Issue[] {
  const issues: Issue[] = [];
  const scopes = domain.scopes();
  const relations = domain.relations();
  const fields = domain.fields();

  const walk = (s: Selector, p: string, branch: boolean): void => {
    switch (s.kind) {
      case "ids":
        break;
      case "scope":
        if (!scopes.has(s.scope)) {
          issues.push({
            path: `${p}.scope`,
            code: "E_UNKNOWN_SCOPE",
            message: `scope "${s.scope}" is not declared by this domain`,
            hint: `declared scopes: ${[...scopes.keys()].join(", ")}`,
          });
        }
        break;
      case "members":
        if (!relations.has(s.relation)) {
          issues.push({
            path: `${p}.relation`,
            code: "E_UNKNOWN_RELATION",
            message: `relation "${s.relation}" is not declared by this domain`,
            hint: `declared relations: ${[...relations.keys()].join(", ")}`,
          });
        }
        walk(s.nodes, `${p}.nodes`, branch);
        break;
      case "positions":
        if (!s.scope && !branch) {
          issues.push({
            path: p,
            code: "E_SCOPE_REQUIRED",
            message: "positions without a scope are only legal inside withinEach",
            hint: "add a `scope` selector, or wrap in withinEach",
          });
        }
        if (s.scope) walk(s.scope, `${p}.scope`, branch);
        break;
      case "offset":
        walk(s.anchor, `${p}.anchor`, branch);
        break;
      case "expand":
      case "siblings":
      case "flatten":
        walk(s.selector, `${p}.selector`, branch);
        break;
      case "between":
        walk(s.anchors[0], `${p}.anchors[0]`, branch);
        walk(s.anchors[1], `${p}.anchors[1]`, branch);
        break;
      case "where":
        if (!s.scope && !branch) {
          issues.push({
            path: p,
            code: "E_SCOPE_REQUIRED",
            message: "where without a scope is only legal inside withinEach",
            hint: "add a `scope` selector, or wrap in withinEach",
          });
        }
        if (s.scope) walk(s.scope, `${p}.scope`, branch);
        validatePredicate(s.predicate, domain, `${p}.predicate`, issues);
        break;
      case "union":
      case "intersect":
        for (const [i, sub] of s.selectors.entries()) walk(sub, `${p}.selectors[${i}]`, branch);
        break;
      case "subtract":
        walk(s.from, `${p}.from`, branch);
        walk(s.remove, `${p}.remove`, branch);
        break;
      case "complement":
        walk(s.selector, `${p}.selector`, branch);
        walk(s.within, `${p}.within`, branch);
        break;
      case "sort":
        for (const [i, k] of s.by.entries()) {
          if (!fields.has(k.field)) {
            issues.push({
              path: `${p}.by[${i}].field`,
              code: "E_UNKNOWN_FIELD",
              message: `sort field "${k.field}" is not in the domain's catalog`,
              hint: `declared fields: ${[...fields.keys()].join(", ")}`,
            });
          }
        }
        walk(s.selector, `${p}.selector`, branch);
        break;
      case "slice":
        walk(s.selector, `${p}.selector`, branch);
        break;
      case "withinEach":
        if (!relations.has(s.relation)) {
          issues.push({
            path: `${p}.relation`,
            code: "E_UNKNOWN_RELATION",
            message: `relation "${s.relation}" is not declared by this domain`,
            hint: `declared relations: ${[...relations.keys()].join(", ")}`,
          });
        }
        walk(s.branches, `${p}.branches`, branch);
        // The inner selector may use scope-less leaves: branch context is on.
        walk(s.select, `${p}.select`, true);
        break;
    }
  };
  walk(selector, path, inBranch);
  return issues;
}

/** Throwing wrapper: parse limits + semantics in one call. */
export function assertValid<Ref>(
  selector: Selector,
  domain: SelectionDomain<Ref>,
  limits: Limits = DEFAULT_LIMITS,
): void {
  analyzeComplexity(selector, limits);
  const issues = validateSelector(selector, domain);
  if (issues.length > 0) throw new ControlLanguageError(issues[0] as Issue, issues);
}
