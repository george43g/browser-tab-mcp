/**
 * @george43g/control-language — pure, domain-agnostic selection language.
 *
 * Phase 1 of the selection-DSL workstream (architecture doc §13): selector
 * schemas, signed positional semantics, same-kind ordered-set algebra,
 * explicit member projection, typed predicates over a domain field catalog,
 * and snapshot-bound resolution over a SelectionDomain ordered view.
 *
 * Selection only. No effects, transformations, daemons, persistence, or MCP.
 */

export {
  type FieldType,
  keysOf,
  type ResolvedOccurrence,
  type ResolvedSelection,
  type SelectionDomain,
} from "./domain.js";
export {
  ControlLanguageError,
  ERROR_CODES,
  type ErrorCode,
  type Issue,
} from "./errors.js";
export { type FixtureEntity, makeSyntheticDomain, type SyntheticTrack } from "./fixture.js";
export { normalizeSelector } from "./normalize.js";
export {
  type Bounds,
  resolveAbsolute,
  resolveOffsets,
  resolveRange,
} from "./positions.js";
export { evalPredicate, globToRegExp, OPS_BY_TYPE } from "./predicate.js";
export { resolveSelector } from "./resolve.js";
export {
  type OffsetRange,
  type PositionExpr,
  type PositionRange,
  PREDICATE_OPS,
  type Predicate,
  type PredicateOp,
  PredicateSchema,
  SELECTOR_SCHEMA_VERSION,
  type Selector,
  type SelectorEnvelope,
  SelectorEnvelopeSchema,
  SelectorSchema,
  type SortKey,
} from "./schema.js";
export {
  analyzeComplexity,
  assertValid,
  DEFAULT_LIMITS,
  type Limits,
  parseSelector,
  validateSelector,
} from "./validate.js";
