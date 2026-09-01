/**
 * Pure snapshot-bound selector resolution (spec §6):
 *
 *   selector + snapshot(domain view) -> resolved ordered selection
 *
 * No mutation, no I/O, no time reads. Determinism rules implemented here:
 *
 * - a selection is an ordered, deduplicated (by stable identity) sequence;
 * - union is left-biased: A then previously-unseen members of B (§7.7);
 * - intersection and subtraction keep the left operand's order (§7.7);
 * - complement uses its declared scope's order (§7.7);
 * - descending ranges keep their reverse order (§5.3);
 * - withinEach evaluates its inner selector once per branch and concatenates
 *   in branch order — observably different from selecting over the flattened
 *   combined sequence (§24.2);
 * - same-kind closure: algebra operands must resolve to one kind; structural
 *   selections become member selections only through the explicit `members`
 *   projection (§24.1). Violations throw E_KIND_MISMATCH — the resolver never
 *   infers a projection to make an expression type-check.
 *
 * Kind checking happens here (not statically) because only resolution knows
 * what kind an `ids` list names. Lossy-but-legal events (clamps, clips,
 * skipped ids) surface as warnings on the result, never as silent drops.
 */

import type { ResolvedOccurrence, ResolvedSelection, SelectionDomain } from "./domain.js";
import { fail } from "./errors.js";
import { type Bounds, resolveAbsolute, resolveOffsets, resolveRange } from "./positions.js";
import { evalPredicate } from "./predicate.js";
import type { Selector } from "./schema.js";
import { analyzeComplexity, DEFAULT_LIMITS, type Limits } from "./validate.js";

const PRIMARY_PROJECTION = "primary";

interface Ctx<Ref> {
  domain: SelectionDomain<Ref>;
  warnings: string[];
  /** Current withinEach branch member sequence, when inside one. */
  branchMembers?: readonly Ref[];
  branchKey?: string;
}

/** Intermediate working form: ordered refs + per-ref branch provenance. */
interface Working<Ref> {
  kind: string;
  refs: Ref[];
  branchOf: Map<string, string | undefined>;
}

function emptyWorking<Ref>(kind: string): Working<Ref> {
  return { kind, refs: [], branchOf: new Map() };
}

function fromRefs<Ref>(
  ctx: Ctx<Ref>,
  refs: readonly Ref[],
  path: string,
  branchKey?: string,
): Working<Ref> {
  if (refs.length === 0) return emptyWorking("empty");
  const kinds = new Set(refs.map((r) => ctx.domain.kindOf(r)));
  if (kinds.size > 1) {
    fail(
      "E_KIND_MISMATCH",
      path,
      `selection mixes kinds: ${[...kinds].join(", ")}`,
      "project structural nodes through `members` so every operand shares one kind",
    );
  }
  const w = emptyWorking<Ref>([...kinds][0] as string);
  for (const r of refs) {
    const k = ctx.domain.stableKey(r);
    if (!w.branchOf.has(k)) {
      w.refs.push(r);
      w.branchOf.set(k, branchKey);
    }
  }
  return w;
}

/** Dedup-preserving append (left-biased union primitive). */
function appendUnique<Ref>(ctx: Ctx<Ref>, into: Working<Ref>, from: Working<Ref>): void {
  for (const r of from.refs) {
    const k = ctx.domain.stableKey(r);
    if (!into.branchOf.has(k)) {
      into.refs.push(r);
      into.branchOf.set(k, from.branchOf.get(k));
    }
  }
}

function requireSameKind<Ref>(parts: Working<Ref>[], path: string): string {
  const kinds = new Set(parts.filter((p) => p.refs.length > 0).map((p) => p.kind));
  if (kinds.size > 1) {
    fail(
      "E_KIND_MISMATCH",
      path,
      `set-algebra operands resolve to different kinds: ${[...kinds].join(", ")}`,
      "project structural operands through `members` first (spec §24.1: no silent coercion)",
    );
  }
  return kinds.size === 1 ? ([...kinds][0] as string) : "empty";
}

function requireSingular<Ref>(w: Working<Ref>, path: string, role: string): Ref {
  if (w.refs.length !== 1) {
    fail(
      "E_ANCHOR_NOT_SINGULAR",
      path,
      `${role} resolved to ${w.refs.length} members; exactly one is required`,
    );
  }
  return w.refs[0] as Ref;
}

function indexIn<Ref>(ctx: Ctx<Ref>, seq: readonly Ref[], ref: Ref): number {
  const key = ctx.domain.stableKey(ref);
  return seq.findIndex((r) => ctx.domain.stableKey(r) === key);
}

function evalNode<Ref>(ctx: Ctx<Ref>, s: Selector, path: string): Working<Ref> {
  const d = ctx.domain;
  switch (s.kind) {
    case "ids": {
      const missing = s.missing ?? "error";
      const refs: Ref[] = [];
      for (const [i, id] of s.ids.entries()) {
        const r = d.byKey(id);
        if (r === undefined) {
          if (missing === "error") {
            fail(
              "E_UNKNOWN_ID",
              `${path}.ids[${i}]`,
              `no entity with key "${id}" exists in this snapshot`,
              'refresh the snapshot and retry, or use missing:"skip"',
            );
          }
          ctx.warnings.push(`${path}.ids[${i}]: key "${id}" not found — skipped`);
          continue;
        }
        refs.push(r);
      }
      return fromRefs(ctx, refs, path);
    }
    case "scope": {
      const kind = d.scopes().get(s.scope);
      if (kind === undefined) {
        fail(
          "E_UNKNOWN_SCOPE",
          `${path}.scope`,
          `scope "${s.scope}" is not declared by this domain`,
          `declared scopes: ${[...d.scopes().keys()].join(", ")}`,
        );
      }
      return fromRefs(ctx, d.scopeMembers(s.scope), path);
    }
    case "members": {
      const resultKind = d.relations().get(s.relation);
      if (resultKind === undefined) {
        fail(
          "E_UNKNOWN_RELATION",
          `${path}.relation`,
          `relation "${s.relation}" is not declared by this domain`,
          `declared relations: ${[...d.relations().keys()].join(", ")}`,
        );
      }
      const nodes = evalNode(ctx, s.nodes, `${path}.nodes`);
      const out = emptyWorking<Ref>(resultKind);
      for (const parent of nodes.refs) {
        const members = d.orderedMembers(parent, s.relation);
        if (members === undefined) {
          fail(
            "E_RELATION_INAPPLICABLE",
            `${path}.relation`,
            `relation "${s.relation}" does not apply to kind "${d.kindOf(parent)}" (node "${d.stableKey(parent)}")`,
            "select nodes of a kind this relation projects from",
          );
        }
        appendUnique(ctx, out, fromRefs(ctx, members, path, d.stableKey(parent)));
      }
      out.kind = out.refs.length > 0 ? out.kind : resultKind;
      return out;
    }
    case "positions": {
      const seq = scopeSequence(ctx, s.scope, `${path}.scope`, path);
      const bounds: Bounds = s.bounds ?? "clamp";
      const idxs: number[] = [];
      for (const [i, pe] of s.positions.entries()) {
        if (typeof pe === "number") {
          const idx = resolveAbsolute(pe, seq.refs.length, bounds, `${path}.positions[${i}]`);
          if (idx !== undefined) {
            const nat = pe > 0 ? pe - 1 : seq.refs.length + pe;
            if (nat !== idx)
              ctx.warnings.push(`${path}.positions[${i}]: position ${pe} clamped to boundary`);
            idxs.push(idx);
          }
        } else {
          idxs.push(
            ...resolveRange(pe.from, pe.to, seq.refs.length, bounds, `${path}.positions[${i}]`),
          );
        }
      }
      const out = fromRefs(
        ctx,
        idxs.map((i) => seq.refs[i] as Ref),
        path,
        ctx.branchKey,
      );
      out.kind = out.refs.length > 0 ? out.kind : seq.kind;
      return out;
    }
    case "offset": {
      const anchor = requireSingular(
        evalNode(ctx, s.anchor, `${path}.anchor`),
        `${path}.anchor`,
        "offset anchor",
      );
      const sibs = d.siblingsOf(anchor);
      const at = indexIn(ctx, sibs, anchor);
      if (at < 0) {
        fail(
          "E_NO_COMMON_PARENT",
          `${path}.anchor`,
          "anchor is missing from its own sibling sequence — domain adapter defect",
        );
      }
      const picked = resolveOffsets(at, s.offsets.from, s.offsets.to, sibs.length);
      const span = Math.abs(s.offsets.to - s.offsets.from) + 1;
      if (picked.length < span)
        ctx.warnings.push(`${path}.offsets: neighbourhood clipped at a sequence boundary`);
      return fromRefs(
        ctx,
        picked.map((i) => sibs[i] as Ref),
        path,
      );
    }
    case "expand": {
      const base = evalNode(ctx, s.selector, `${path}.selector`);
      const out = emptyWorking<Ref>(base.kind);
      for (const m of base.refs) {
        const sibs = d.siblingsOf(m);
        const at = indexIn(ctx, sibs, m);
        const picked = resolveOffsets(at, s.offsets.from, s.offsets.to, sibs.length);
        appendUnique(
          ctx,
          out,
          fromRefs(
            ctx,
            picked.map((i) => sibs[i] as Ref),
            path,
          ),
        );
      }
      return out;
    }
    case "between": {
      const a = requireSingular(
        evalNode(ctx, s.anchors[0], `${path}.anchors[0]`),
        `${path}.anchors[0]`,
        "between anchor",
      );
      const b = requireSingular(
        evalNode(ctx, s.anchors[1], `${path}.anchors[1]`),
        `${path}.anchors[1]`,
        "between anchor",
      );
      const pa = d.parentOf(a);
      const pb = d.parentOf(b);
      const ka = pa === undefined ? undefined : d.stableKey(pa);
      const kb = pb === undefined ? undefined : d.stableKey(pb);
      if (ka !== kb) {
        fail(
          "E_NO_COMMON_PARENT",
          path,
          "between anchors do not share an ordered parent",
          "pick anchors inside one branch, or use union of per-branch selections",
        );
      }
      const sibs = d.siblingsOf(a);
      const ia = indexIn(ctx, sibs, a);
      const ib = indexIn(ctx, sibs, b);
      const step = ia <= ib ? 1 : -1;
      const inclusive = s.inclusive ?? true;
      const lo = inclusive ? ia : ia + step;
      const hi = inclusive ? ib : ib - step;
      const refs: Ref[] = [];
      for (let i = lo; step > 0 ? i <= hi : i >= hi; i += step) refs.push(sibs[i] as Ref);
      return fromRefs(ctx, refs, path);
    }
    case "siblings": {
      const base = evalNode(ctx, s.selector, `${path}.selector`);
      const out = emptyWorking<Ref>(base.kind);
      for (const m of base.refs) appendUnique(ctx, out, fromRefs(ctx, d.siblingsOf(m), path));
      return out;
    }
    case "where": {
      const seq = scopeSequence(ctx, s.scope, `${path}.scope`, path);
      const unknown = s.unknown ?? "exclude";
      const refs = seq.refs.filter((r) =>
        evalPredicate(d, r, s.predicate, unknown, `${path}.predicate`),
      );
      const out = fromRefs(ctx, refs, path, ctx.branchKey);
      out.kind = refs.length > 0 ? out.kind : seq.kind;
      return out;
    }
    case "union": {
      const parts = s.selectors.map((sub, i) => evalNode(ctx, sub, `${path}.selectors[${i}]`));
      const kind = requireSameKind(parts, path);
      const out = emptyWorking<Ref>(kind);
      for (const p of parts) appendUnique(ctx, out, p);
      return out;
    }
    case "intersect": {
      const parts = s.selectors.map((sub, i) => evalNode(ctx, sub, `${path}.selectors[${i}]`));
      const kind = requireSameKind(parts, path);
      const [first, ...rest] = parts as [Working<Ref>, ...Working<Ref>[]];
      const keySets = rest.map((p) => new Set(p.refs.map((r) => d.stableKey(r))));
      const refs = first.refs.filter((r) => keySets.every((ks) => ks.has(d.stableKey(r))));
      const out = fromRefs(ctx, refs, path);
      out.kind = refs.length > 0 ? out.kind : kind;
      return out;
    }
    case "subtract": {
      const from = evalNode(ctx, s.from, `${path}.from`);
      const remove = evalNode(ctx, s.remove, `${path}.remove`);
      requireSameKind([from, remove], path);
      const removeKeys = new Set(remove.refs.map((r) => d.stableKey(r)));
      const refs = from.refs.filter((r) => !removeKeys.has(d.stableKey(r)));
      const out = fromRefs(ctx, refs, path);
      out.kind = refs.length > 0 ? out.kind : from.kind;
      return out;
    }
    case "complement": {
      const within = evalNode(ctx, s.within, `${path}.within`);
      const sel = evalNode(ctx, s.selector, `${path}.selector`);
      requireSameKind([within, sel], path);
      const selKeys = new Set(sel.refs.map((r) => d.stableKey(r)));
      const refs = within.refs.filter((r) => !selKeys.has(d.stableKey(r)));
      const out = fromRefs(ctx, refs, path);
      out.kind = refs.length > 0 ? out.kind : within.kind;
      return out;
    }
    case "sort": {
      const base = evalNode(ctx, s.selector, `${path}.selector`);
      const keys = s.by.map((k) => ({ field: k.field, dir: k.direction === "desc" ? -1 : 1 }));
      // Stable: JS Array.prototype.sort is stable (ES2019).
      const refs = [...base.refs].sort((a, b) => {
        for (const { field, dir } of keys) {
          const va = d.readField(a, field);
          const vb = d.readField(b, field);
          const ua = va === undefined || va === null;
          const ub = vb === undefined || vb === null;
          if (ua && ub) continue;
          if (ua) return 1; // undefined sorts last regardless of direction
          if (ub) return -1;
          if ((va as number | string | boolean) < (vb as number | string | boolean))
            return -1 * dir;
          if ((va as number | string | boolean) > (vb as number | string | boolean)) return 1 * dir;
        }
        return 0;
      });
      const out = fromRefs(ctx, refs, path);
      out.kind = refs.length > 0 ? out.kind : base.kind;
      return out;
    }
    case "slice": {
      const base = evalNode(ctx, s.selector, `${path}.selector`);
      const idxs = resolveRange(
        s.range.from,
        s.range.to,
        base.refs.length,
        s.bounds ?? "clamp",
        `${path}.range`,
      );
      const out = fromRefs(
        ctx,
        idxs.map((i) => base.refs[i] as Ref),
        path,
      );
      out.kind = out.refs.length > 0 ? out.kind : base.kind;
      return out;
    }
    case "withinEach": {
      const resultKind = d.relations().get(s.relation);
      if (resultKind === undefined) {
        fail(
          "E_UNKNOWN_RELATION",
          `${path}.relation`,
          `relation "${s.relation}" is not declared by this domain`,
          `declared relations: ${[...d.relations().keys()].join(", ")}`,
        );
      }
      const branches = evalNode(ctx, s.branches, `${path}.branches`);
      const out = emptyWorking<Ref>(resultKind);
      for (const branch of branches.refs) {
        const members = d.orderedMembers(branch, s.relation);
        if (members === undefined) {
          fail(
            "E_RELATION_INAPPLICABLE",
            `${path}.relation`,
            `relation "${s.relation}" does not apply to kind "${d.kindOf(branch)}" (branch "${d.stableKey(branch)}")`,
          );
        }
        const branchCtx: Ctx<Ref> = {
          ...ctx,
          branchMembers: members,
          branchKey: d.stableKey(branch),
        };
        const inner = evalNode(branchCtx, s.select, `${path}.select`);
        appendUnique(ctx, out, inner);
      }
      out.kind = out.refs.length > 0 ? out.kind : resultKind;
      return out;
    }
    case "flatten": {
      const base = evalNode(ctx, s.selector, `${path}.selector`);
      // Order unchanged; provenance erased (partitions never alter behaviour).
      const out = emptyWorking<Ref>(base.kind);
      for (const r of base.refs) {
        const k = d.stableKey(r);
        if (!out.branchOf.has(k)) {
          out.refs.push(r);
          out.branchOf.set(k, undefined);
        }
      }
      return out;
    }
  }
}

/** Resolve the scope of a leaf node: explicit selector, or the current branch. */
function scopeSequence<Ref>(
  ctx: Ctx<Ref>,
  scope: Selector | undefined,
  scopePath: string,
  nodePath: string,
): Working<Ref> {
  if (scope !== undefined) return evalNode(ctx, scope, scopePath);
  if (ctx.branchMembers !== undefined)
    return fromRefs(ctx, ctx.branchMembers, nodePath, ctx.branchKey);
  fail(
    "E_SCOPE_REQUIRED",
    nodePath,
    "this node needs a scope: none was given and it is not inside withinEach",
    "add a `scope` selector, or wrap the expression in withinEach",
  );
}

/**
 * Resolve a selector against a domain snapshot view. Pure; deterministic for
 * a given (selector, domain-state) pair. Enforces complexity limits first.
 */
export function resolveSelector<Ref>(
  selector: Selector,
  domain: SelectionDomain<Ref>,
  opts?: { limits?: Limits },
): ResolvedSelection<Ref> {
  analyzeComplexity(selector, opts?.limits ?? DEFAULT_LIMITS);
  const ctx: Ctx<Ref> = { domain, warnings: [] };
  const w = evalNode(ctx, selector, "$");
  const occurrences: ResolvedOccurrence<Ref>[] = w.refs.map((r, i) => {
    const key = domain.stableKey(r);
    const branch = w.branchOf.get(key);
    const branchPath = branch === undefined ? [] : [branch];
    return {
      entity: r,
      key,
      projectionId: PRIMARY_PROJECTION,
      occurrenceId: `${PRIMARY_PROJECTION}:${branchPath.join("/")}:${key}`,
      branchPath,
      ordinal: i,
    };
  });
  return { kind: w.kind, occurrences, warnings: ctx.warnings };
}
