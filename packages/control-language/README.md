# @george43g/control-language

Pure, domain-agnostic **selection language** — Phase 1 of the selection-DSL
workstream (spec: `docs/tab-selection-transformation-language-spec.md`,
architecture: `docs/deep-application-control-platform-architecture.md` §4/§13).

A selector is a versioned, Zod-validated recursive AST that resolves — purely,
against one snapshot view — to an **ordered, deduplicated selection** with
branch provenance. This package owns the language; domains (browser, later
tmux) own the entities, and bind in through one interface.

## What this package owns

- **Versioned selector schemas** (`SelectorSchema`, `SelectorEnvelopeSchema`,
  `SELECTOR_SCHEMA_VERSION`): every union discriminated on `kind`, every
  object closed, every field described, defaults safe and visible (spec §22.1).
- **Signed positional semantics** (spec §5, exactly): one-based signed
  absolute positions (`1` first, `-1` last, `0` invalid), clamp-by-default
  with `bounds:"error"`, inclusive direction-preserving ranges (a descending
  range keeps its reverse order), zero-based relative offsets that clip and
  never wrap.
- **Same-kind ordered-set algebra** (spec §7.7/§24.1): left-biased `union`,
  A-ordered `intersect`/`subtract` (explicit `from`/`remove` roles),
  `complement` within a finite scope. Operands must share one result kind;
  structural selections become member selections ONLY through the explicit
  `members` projection — the resolver never infers one.
- **Relative and structural selectors**: `positions`, `offset`, `expand`,
  `between`, `siblings`, `sort` (stable; undefined last), `slice`,
  `withinEach` (per-branch evaluation — observably different from selecting
  over the `flatten`ed combined sequence, spec §24.2).
- **Typed predicates over a domain field catalog** (spec §7.5): the package
  owns the operators (`eq ne lt le gt ge contains prefix suffix glob regex
  in exists`, `and/or/not`); the domain declares the fields and their types,
  and operator/type compatibility is validated before resolution. Unknown
  field values follow the where-node policy (`exclude` default / `error`,
  spec §24.6) — and `not` of an unknown stays excluded: absence of evidence
  never becomes evidence.
- **Validation with actionable errors** (spec §22.3): every failure carries a
  JSON path, a stable `E_*` code, the violated constraint, and a correction
  hint. Documented complexity limits (`DEFAULT_LIMITS`: depth 16, nodes 256,
  list length 1024).
- **Pure resolution** over the `SelectionDomain` ordered-view interface, with
  `ResolvedOccurrence` provenance (entity/occurrence/projection separation,
  architecture doc §4) so graph-shaped domains fit later without remodeling.
- **A synthetic fixture** (`makeSyntheticDomain()` — a music library, on
  purpose not a browser) plus property-based tests for the algebra laws.

## What this package deliberately does NOT own

No daemons, persistence, MCP tools, effects/transformations (`move`, `copy`,
`cut`…), browser live-move policy, capability probing, tmux commands, undo, or
a universal transformation hierarchy. Those live in the domain packages
(`browser-control` next, per architecture doc §6) — extracting them here
before two domains prove the duplication is the anti-pattern the architecture
doc's §12 forbids.

## Decisions Phase 1 froze (spec left them open)

- **Leaf scopes are explicit.** `positions`/`where` without a `scope` are
  legal only inside `withinEach`, where the current branch's members are the
  scope. "Default scope = focused window" is a browser-domain convenience the
  browser binding compiles in before calling this resolver.
- **`withinEach` and `members` name their `relation` explicitly** — a generic
  evaluator must not infer windows→tabs.
- **Kind agreement is checked at resolve time** (only resolution knows what
  kind an `ids` list names); scope/relation/field names and operator/type
  compatibility are checked statically by `validateSelector`.
- **Unknown-policy `include` is deferred** until a real caller needs it;
  `exclude`/`error` are implemented.
- **Empty selections are legal at resolve level** — mutation-time
  `emptySelection` policy belongs to the planner (Phase 3).

## Usage

```ts
import { makeSyntheticDomain, parseSelector, resolveSelector, keysOf } from "@george43g/control-language";

const domain = makeSyntheticDomain(); // or a real SelectionDomain binding
const selector = parseSelector({
  kind: "withinEach",
  branches: { kind: "scope", scope: "allPlaylists" },
  relation: "tracks",
  select: { kind: "positions", positions: [-1] },
});
const result = resolveSelector(selector, domain);
keysOf(result); // last track of EACH playlist — not of the combined sequence
```
