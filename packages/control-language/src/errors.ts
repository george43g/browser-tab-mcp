/**
 * Structured errors for the control language.
 *
 * Spec §22.3: validation failures returned to an AI MUST be actionable —
 * exact JSON path, stable error code, violated constraint, correction hint.
 * Every throw in this package goes through ControlLanguageError so callers
 * (and later, MCP tool wrappers) can surface all four without re-parsing
 * prose.
 */

/** Stable machine-readable error codes. Add — never repurpose — codes. */
export const ERROR_CODES = [
  /** Selector JSON failed schema validation (shape, discriminator, field types). */
  "E_SCHEMA",
  /** Selector exceeds a documented complexity limit (depth / node count / list length). */
  "E_COMPLEXITY",
  /** A named scope is not declared by the domain. */
  "E_UNKNOWN_SCOPE",
  /** A named member relation is not declared by the domain. */
  "E_UNKNOWN_RELATION",
  /** A predicate/sort field is not declared in the domain's field catalog. */
  "E_UNKNOWN_FIELD",
  /** A predicate operator is incompatible with the field's declared type. */
  "E_OP_TYPE_MISMATCH",
  /** An identity selector named a key the snapshot does not contain. */
  "E_UNKNOWN_ID",
  /** Set-algebra operands (or ids in one list) resolved to different kinds. */
  "E_KIND_MISMATCH",
  /** A member relation does not apply to the kind it was projected from. */
  "E_RELATION_INAPPLICABLE",
  /** An absolute position or slice endpoint is out of range under bounds:"error". */
  "E_OUT_OF_RANGE",
  /** A leaf selector needing a scope has none, and no withinEach branch supplies one. */
  "E_SCOPE_REQUIRED",
  /** An anchor selector resolved to zero or more than one member. */
  "E_ANCHOR_NOT_SINGULAR",
  /** between/offset anchors do not share the ordered parent the operation needs. */
  "E_NO_COMMON_PARENT",
  /** A regex predicate value failed to compile. */
  "E_INVALID_REGEX",
  /** A field read returned no value and the where-node policy is unknown:"error". */
  "E_UNKNOWN_FIELD_VALUE",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** One actionable problem, addressed by JSON path into the selector document. */
export interface Issue {
  /** JSON path into the selector document, e.g. "selectors[1].positions[0]". */
  path: string;
  /** Stable machine-readable code from ERROR_CODES. */
  code: ErrorCode;
  /** Human-readable statement of the violated constraint. */
  message: string;
  /** Concise correction hint — what a caller should change. */
  hint?: string | undefined;
}

export class ControlLanguageError extends Error {
  readonly code: ErrorCode;
  readonly path: string;
  readonly hint: string | undefined;
  /** All issues when the error aggregates a validation pass; ≥1 entry, first = this error. */
  readonly issues: readonly Issue[];

  constructor(issue: Issue, allIssues?: readonly Issue[]) {
    super(
      `${issue.code} at ${issue.path || "$"}: ${issue.message}${issue.hint ? ` (hint: ${issue.hint})` : ""}`,
    );
    this.name = "ControlLanguageError";
    this.code = issue.code;
    this.path = issue.path;
    this.hint = issue.hint;
    this.issues = allIssues ?? [issue];
  }
}

/** Convenience thrower keeping call sites one-line. */
export function fail(code: ErrorCode, path: string, message: string, hint?: string): never {
  throw new ControlLanguageError({ code, path, message, hint });
}
