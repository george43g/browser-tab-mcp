/**
 * Versioned selector AST — the canonical structured representation
 * (spec §12.1/§24, under the model-friendly schema rules of §22.1):
 *
 * - every union has a required literal `kind` discriminator;
 * - every object is closed (`.strict()`);
 * - enums over free strings for finite choices;
 * - one meaning, one type per field (subtract has explicit from/remove roles
 *   rather than an ambiguous unordered array — §24.4);
 * - defaults are safe and visible (bounds:"clamp", inclusive:true,
 *   unknown:"exclude", missing:"error");
 * - documented complexity limits (see limits.ts);
 * - `.describe()` on every field.
 *
 * Deliberate deviations from the spec's illustrative sketches, made because
 * this is the generic package and domain defaults don't exist here:
 *
 * - Leaf selectors (`positions`, `where`, `sort` reached as leaves) take an
 *   explicit `scope` selector; it may be omitted ONLY inside `withinEach`,
 *   where the current branch's members are the scope. "Default scope = the
 *   focused window" is a browser-domain convenience the browser binding will
 *   compile in before handing the AST to this resolver.
 * - `withinEach` carries an explicit `relation` naming the projection used to
 *   enumerate each branch's members — the spec's example implies windows→tabs;
 *   a generic evaluator must not infer a projection (§24.1).
 * - `members` (explicit structural projection) names its `relation` for the
 *   same reason.
 */

import { z } from "zod";
import type { Bounds } from "./positions.js";

/** Schema version for the selector document format. Bump on breaking change. */
export const SELECTOR_SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Scalars
// ---------------------------------------------------------------------------

/** Signed one-based absolute position: 1 first, -1 last; 0 invalid (§5.1). */
const SignedPosition = z
  .number()
  .int()
  .refine((n) => n !== 0, {
    message: "position 0 is invalid: positions are one-based and signed (1 = first, -1 = last)",
  })
  .describe("Signed one-based position: 1 = first, -1 = last, 0 invalid. Never wraps.");

/** Inclusive signed range; direction is preserved (§5.3). */
const PositionRangeSchema = z
  .object({
    from: SignedPosition.describe("Inclusive start position (signed, one-based)."),
    to: SignedPosition.describe(
      "Inclusive end position (signed, one-based). May precede `from`: a descending range keeps its reverse order.",
    ),
  })
  .strict()
  .describe("Inclusive signed position range. Direction is part of the resulting order.");
export type PositionRange = z.infer<typeof PositionRangeSchema>;

/** One position or an inclusive range (discrete lists mix both — §7.3). */
const PositionExprSchema = z
  .union([SignedPosition, PositionRangeSchema])
  .describe("One signed position, or an inclusive signed range object.");
export type PositionExpr = z.infer<typeof PositionExprSchema>;

/** Zero-based relative offset range around an anchor: 0 = the anchor (§5.2). */
const OffsetRangeSchema = z
  .object({
    from: z
      .number()
      .int()
      .describe(
        "Inclusive start offset, zero-based from the anchor (0 = anchor, negative = earlier).",
      ),
    to: z
      .number()
      .int()
      .describe(
        "Inclusive end offset, zero-based from the anchor. May precede `from` for a descending walk.",
      ),
  })
  .strict()
  .describe(
    "Inclusive zero-based offset range around an anchor. Out-of-range offsets clip; they never wrap.",
  );
export type OffsetRange = z.infer<typeof OffsetRangeSchema>;

const BoundsSchema = z
  .enum(["clamp", "error"])
  .describe(
    'Out-of-range policy for absolute positions: "clamp" (default) snaps to the nearest boundary, "error" rejects.',
  );

// ---------------------------------------------------------------------------
// Predicates
// ---------------------------------------------------------------------------

/** Comparison / string / membership operators over declared domain fields. */
export const PREDICATE_OPS = [
  "eq",
  "ne",
  "lt",
  "le",
  "gt",
  "ge",
  "contains",
  "prefix",
  "suffix",
  "glob",
  "regex",
  "in",
  "exists",
] as const;
export type PredicateOp = (typeof PREDICATE_OPS)[number];

const PredicateValue = z
  .union([z.string(), z.number(), z.boolean()])
  .describe("Literal to compare the field against.");

export type Predicate =
  | {
      kind: "cmp";
      field: string;
      op: Exclude<PredicateOp, "in" | "exists">;
      value: string | number | boolean;
    }
  | { kind: "inSet"; field: string; values: (string | number)[] }
  | { kind: "exists"; field: string }
  | { kind: "and"; predicates: Predicate[] }
  | { kind: "or"; predicates: Predicate[] }
  | { kind: "not"; predicate: Predicate };

// The lazy bodies below are MEMOIZED on purpose: ZodLazy calls its getter on
// every `.schema` access, and a getter that builds a fresh discriminatedUnion
// each time defeats zod-to-json-schema's identity-based cycle detection —
// the converter recurses forever and tools/list dies with a stack overflow
// (caught by apps/browser-tab-mcp/src/tools/select-tabs.test.ts the first
// time a tool embedded this schema). Returning the same instance turns the
// recursion into a $ref.
let predicateUnion: z.ZodType<Predicate> | undefined;
export const PredicateSchema: z.ZodType<Predicate> = z.lazy(
  () =>
    (predicateUnion ??= z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("cmp").describe("Compare one declared field against a literal."),
          field: z.string().min(1).describe("Field name from the domain's typed field catalog."),
          op: z
            .enum([
              "eq",
              "ne",
              "lt",
              "le",
              "gt",
              "ge",
              "contains",
              "prefix",
              "suffix",
              "glob",
              "regex",
            ])
            .describe(
              "Comparison operator. String operators (contains/prefix/suffix/glob/regex) require a string-typed field.",
            ),
          value: PredicateValue,
        })
        .strict(),
      z
        .object({
          kind: z
            .literal("inSet")
            .describe("True when the field's value is one of the listed literals."),
          field: z.string().min(1).describe("Field name from the domain's typed field catalog."),
          values: z
            .array(z.union([z.string(), z.number()]))
            .min(1)
            .describe("Allowed values."),
        })
        .strict(),
      z
        .object({
          kind: z.literal("exists").describe("True when the field has a value for this entity."),
          field: z.string().min(1).describe("Field name from the domain's typed field catalog."),
        })
        .strict(),
      z
        .object({
          kind: z.literal("and").describe("All sub-predicates must hold."),
          predicates: z.array(PredicateSchema).min(1).describe("Conjuncts."),
        })
        .strict(),
      z
        .object({
          kind: z.literal("or").describe("At least one sub-predicate must hold."),
          predicates: z.array(PredicateSchema).min(1).describe("Disjuncts."),
        })
        .strict(),
      z
        .object({
          kind: z.literal("not").describe("Negates one sub-predicate."),
          predicate: PredicateSchema,
        })
        .strict(),
    ])),
);

// ---------------------------------------------------------------------------
// Selector AST
// ---------------------------------------------------------------------------

export interface SortKey {
  field: string;
  /** Default "asc" — applied by the resolver when omitted. */
  direction?: "asc" | "desc" | undefined;
}

/**
 * The selector AST as TypeScript types. Fields with schema defaults are
 * optional here so hand-built ASTs stay terse; the resolver applies the same
 * defaults the schema does (clamp / error / exclude / inclusive / asc).
 */
export type Selector =
  | { kind: "ids"; ids: string[]; missing?: "error" | "skip" | undefined }
  | { kind: "scope"; scope: string }
  | { kind: "members"; nodes: Selector; relation: string }
  | {
      kind: "positions";
      scope?: Selector | undefined;
      positions: PositionExpr[];
      bounds?: Bounds | undefined;
    }
  | { kind: "offset"; anchor: Selector; offsets: OffsetRange }
  | { kind: "expand"; selector: Selector; offsets: OffsetRange }
  | { kind: "between"; anchors: [Selector, Selector]; inclusive?: boolean | undefined }
  | { kind: "siblings"; selector: Selector }
  | {
      kind: "where";
      scope?: Selector | undefined;
      predicate: Predicate;
      unknown?: "exclude" | "error" | undefined;
    }
  | { kind: "union"; selectors: Selector[] }
  | { kind: "intersect"; selectors: Selector[] }
  | { kind: "subtract"; from: Selector; remove: Selector }
  | { kind: "complement"; selector: Selector; within: Selector }
  | { kind: "sort"; selector: Selector; by: SortKey[] }
  | { kind: "slice"; selector: Selector; range: PositionRange; bounds?: Bounds | undefined }
  | { kind: "withinEach"; branches: Selector; relation: string; select: Selector }
  | { kind: "flatten"; selector: Selector };

const SortKeySchema = z
  .object({
    field: z.string().min(1).describe("Field name from the domain's typed field catalog."),
    direction: z
      .enum(["asc", "desc"])
      .default("asc")
      .describe('Sort direction; default "asc". The sort is stable.'),
  })
  .strict();

let selectorUnion: z.ZodType<Selector> | undefined;
export const SelectorSchema: z.ZodType<Selector> = z.lazy(
  () =>
    (selectorUnion ??= z.discriminatedUnion("kind", [
      z
        .object({
          kind: z
            .literal("ids")
            .describe(
              "Explicit identity list. Selection order is list order after duplicate removal.",
            ),
          ids: z
            .array(z.string().min(1))
            .min(1)
            .describe("Stable identity keys, in the order the selection should carry."),
          missing: z
            .enum(["error", "skip"])
            .default("error")
            .describe(
              'Unknown-key policy: "error" (default) rejects, "skip" drops the key and records a warning.',
            ),
        })
        .strict(),
      z
        .object({
          kind: z
            .literal("scope")
            .describe(
              "A named finite scope declared by the domain (e.g. every leaf entity, a focused branch).",
            ),
          scope: z.string().min(1).describe("Scope name from the domain's declared scope list."),
        })
        .strict(),
      z
        .object({
          kind: z
            .literal("members")
            .describe(
              "Explicit structural projection: expand structural nodes to their ordered members. Never inferred (spec §24.1).",
            ),
          nodes: SelectorSchema.describe(
            "Structural selection to project. Each node contributes its members in order.",
          ),
          relation: z
            .string()
            .min(1)
            .describe("Member relation name from the domain's declared relation list."),
        })
        .strict(),
      z
        .object({
          kind: z
            .literal("positions")
            .describe("Signed one-based element positions within a scope's ordered sequence."),
          scope: SelectorSchema.optional().describe(
            "Sequence to index into. Omit ONLY inside withinEach, where the current branch's members are the scope.",
          ),
          positions: z
            .array(PositionExprSchema)
            .min(1)
            .describe("Discrete positions and/or inclusive ranges, kept in the order listed."),
          bounds: BoundsSchema.default("clamp"),
        })
        .strict(),
      z
        .object({
          kind: z
            .literal("offset")
            .describe(
              "Zero-based relative neighbourhood around a single anchor, within the anchor's sibling order.",
            ),
          anchor: SelectorSchema.describe("Selector that must resolve to exactly one member."),
          offsets: OffsetRangeSchema,
        })
        .strict(),
      z
        .object({
          kind: z
            .literal("expand")
            .describe(
              "Include the offset neighbourhood around EVERY selected member, then deduplicate (first occurrence wins).",
            ),
          selector: SelectorSchema.describe("Base selection to expand."),
          offsets: OffsetRangeSchema,
        })
        .strict(),
      z
        .object({
          kind: z
            .literal("between")
            .describe(
              "The run bounded by two single-member anchors in their common ordered parent, in anchor order.",
            ),
          anchors: z
            .tuple([SelectorSchema, SelectorSchema])
            .describe(
              "Two selectors, each resolving to exactly one member; both must share a parent.",
            ),
          inclusive: z
            .boolean()
            .default(true)
            .describe("Include the anchors themselves (default true)."),
        })
        .strict(),
      z
        .object({
          kind: z
            .literal("siblings")
            .describe(
              "The full ordered sibling sequence of every selected member (the members themselves included), deduplicated.",
            ),
          selector: SelectorSchema.describe("Base selection."),
        })
        .strict(),
      z
        .object({
          kind: z
            .literal("where")
            .describe("Filter a scope's members by a typed predicate, preserving scope order."),
          scope: SelectorSchema.optional().describe(
            "Members to filter. Omit ONLY inside withinEach, where the current branch's members are the scope.",
          ),
          predicate: PredicateSchema,
          unknown: z
            .enum(["exclude", "error"])
            .default("exclude")
            .describe(
              'Policy when a field read has no value: "exclude" (default) fails the member, "error" rejects the resolution (spec §24.6).',
            ),
        })
        .strict(),
      z
        .object({
          kind: z
            .literal("union")
            .describe(
              "Left-biased ordered union: A then previously-unseen members of B, and so on.",
            ),
          selectors: z
            .array(SelectorSchema)
            .min(2)
            .describe("Operands, all resolving to the same kind."),
        })
        .strict(),
      z
        .object({
          kind: z
            .literal("intersect")
            .describe("Members present in every operand, in the FIRST operand's order."),
          selectors: z
            .array(SelectorSchema)
            .min(2)
            .describe("Operands, all resolving to the same kind."),
        })
        .strict(),
      z
        .object({
          kind: z
            .literal("subtract")
            .describe(
              "Members of `from` not present in `remove`, in `from` order. Roles are explicit — no unordered operand array (spec §24.4).",
            ),
          from: SelectorSchema.describe("Base selection."),
          remove: SelectorSchema.describe("Members to exclude."),
        })
        .strict(),
      z
        .object({
          kind: z
            .literal("complement")
            .describe(
              "Members of the finite `within` scope not selected by `selector`, in `within` order (spec §7.7: complement MUST have a finite scope).",
            ),
          selector: SelectorSchema.describe("Selection to complement."),
          within: SelectorSchema.describe(
            "Finite scope supplying both the universe and the result order.",
          ),
        })
        .strict(),
      z
        .object({
          kind: z
            .literal("sort")
            .describe(
              "Stable sort by one or more declared fields. Undefined field values sort last within their direction.",
            ),
          selector: SelectorSchema.describe("Selection to sort."),
          by: z.array(SortKeySchema).min(1).describe("Sort keys, most significant first."),
        })
        .strict(),
      z
        .object({
          kind: z
            .literal("slice")
            .describe(
              "Inclusive signed sub-range of an already-resolved selection's order (take/drop/limit compile to this).",
            ),
          selector: SelectorSchema.describe("Selection to slice."),
          range: PositionRangeSchema,
          bounds: BoundsSchema.default("clamp"),
        })
        .strict(),
      z
        .object({
          kind: z
            .literal("withinEach")
            .describe(
              "Evaluate `select` once per resolved branch, against that branch's ordered members; concatenate in branch order (spec §24.2). Distinct from selecting over the flattened combined sequence.",
            ),
          branches: SelectorSchema.describe(
            "Structural selection supplying the branches, in caller/scope order.",
          ),
          relation: z
            .string()
            .min(1)
            .describe(
              "Member relation used to enumerate each branch's ordered members — explicit because a generic evaluator must not infer a projection.",
            ),
          select: SelectorSchema.describe(
            "Inner selector. Leaf `positions`/`where` nodes inside it may omit `scope`; the current branch's members are the scope.",
          ),
        })
        .strict(),
      z
        .object({
          kind: z
            .literal("flatten")
            .describe(
              "Erase branch provenance, leaving one plain combined sequence in the existing order. Order is unchanged — partitions never alter behaviour silently, this only normalizes the metadata.",
            ),
          selector: SelectorSchema.describe("Selection whose provenance to erase."),
        })
        .strict(),
    ])),
);

/** Versioned document envelope: what tools and files should carry. */
export const SelectorEnvelopeSchema = z
  .object({
    v: z.literal(SELECTOR_SCHEMA_VERSION).describe("Selector document format version."),
    selector: SelectorSchema.describe("The selector AST."),
  })
  .strict()
  .describe("Versioned selector document.");
export type SelectorEnvelope = z.infer<typeof SelectorEnvelopeSchema>;
