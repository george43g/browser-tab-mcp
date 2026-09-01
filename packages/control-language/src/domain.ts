/**
 * The ordered-view seam between the generic language and a concrete domain
 * (architecture doc §4, finalized here).
 *
 * The evaluator stays ignorant of browser APIs, tmux commands, persistence,
 * and effects. A domain supplies: entity kinds, stable identity, named finite
 * scopes, named member relations (explicit projection — never inferred),
 * sibling order, and a typed field catalog. That is everything selection
 * needs; everything else (capabilities, live-move domains, effects) belongs
 * to the domain packages built on top.
 *
 * Design choices this interface freezes (deviations from the illustrative
 * sketch in the architecture doc, recorded deliberately):
 *
 * - Scopes and relations are NAMED and enumerable, so a validator can reject
 *   an unknown name with a hint listing the valid ones — a generic
 *   `universe(kind, scope)` cannot say what it accepts.
 * - `siblingsOf` is first-class rather than derived from `parentOf` +
 *   relation guessing: relative selectors (offset/expand/between/siblings)
 *   need exactly "the ordered sequence this entity lives in", and only the
 *   domain knows which relation that is.
 * - Field types are declared so operator/type compatibility is checkable
 *   before resolution (spec §22.1: semantic validity, not just syntactic).
 */

export type FieldType = "string" | "number" | "boolean";

export interface SelectionDomain<Ref> {
  /** Entity kind of a ref, e.g. "tab" | "window" (browser) or "track" (fixture). */
  kindOf(ref: Ref): string;
  /** Stable identity key: dedupe, ids-selectors, and occurrence identity all use it. */
  stableKey(ref: Ref): string;
  /** Look up a ref by stable key; undefined when the snapshot does not contain it. */
  byKey(key: string): Ref | undefined;
  /** Named finite scopes this domain exposes: scope name → result kind. */
  scopes(): ReadonlyMap<string, string>;
  /** Ordered members of a named scope. Only called with names from scopes(). */
  scopeMembers(name: string): readonly Ref[];
  /** Named member relations (explicit projections): relation name → result kind. */
  relations(): ReadonlyMap<string, string>;
  /**
   * Ordered members of `parent` under `relation`; undefined when the relation
   * does not apply to the parent's kind (the resolver turns that into
   * E_RELATION_INAPPLICABLE — it never guesses another relation).
   */
  orderedMembers(parent: Ref, relation: string): readonly Ref[] | undefined;
  /** Parent in the primary ordered view; undefined at roots. */
  parentOf(ref: Ref): Ref | undefined;
  /** The ordered sibling sequence containing `ref` (including ref itself). */
  siblingsOf(ref: Ref): readonly Ref[];
  /** Typed field catalog for predicates and sort keys: field name → type. */
  fields(): ReadonlyMap<string, FieldType>;
  /** Read a declared field; undefined means "not available for this entity". */
  readField(ref: Ref, field: string): unknown;
}

/**
 * One resolved occurrence of an entity in an ordered view (architecture doc
 * §4). Browsers have one occurrence per tab so entity ≡ occurrence there;
 * the distinction exists for graph-shaped domains (a tmux window linked into
 * two sessions) and stays invisible in ordinary results.
 */
export interface ResolvedOccurrence<Ref> {
  /** The underlying entity. */
  entity: Ref;
  /** stableKey(entity) — identity used for dedupe. */
  key: string;
  /** Projection/view the ordering was interpreted in ("primary" for now). */
  projectionId: string;
  /** Occurrence identity: projection + branch path + entity key. */
  occurrenceId: string;
  /** Provenance: stable keys of the branch(es) this occurrence came through. */
  branchPath: readonly string[];
  /** Position within the resolved total order (0-based). */
  ordinal: number;
}

/**
 * A resolved selection: one deterministic total order PLUS branch/provenance
 * partitions (spec §24.2 — hidden partitions must never silently alter
 * behavior, so they ride as metadata; withinEach is the explicit per-branch
 * operator).
 */
export interface ResolvedSelection<Ref> {
  /** Result kind every member shares (same-kind closure, spec §24.1). */
  kind: string;
  /** Deduplicated, ordered occurrences. */
  occurrences: readonly ResolvedOccurrence<Ref>[];
  /** Lossy-but-legal events observed during resolution (clamps, clips, skips). */
  warnings: readonly string[];
}

/** Ordered stable keys of a resolved selection — the usual assertion surface. */
export function keysOf<Ref>(sel: ResolvedSelection<Ref>): string[] {
  return sel.occurrences.map((o) => o.key);
}
