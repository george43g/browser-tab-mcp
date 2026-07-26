# @george43g/shared-types

The single source of truth for browser-tab's typed contracts — every Zod
schema (and its inferred TS type) that crosses a process, socket, or language
boundary lives here. A `tsc`-built package: consumers import the compiled
`dist/index.js`.

## Module layout

`src/index.ts` is a thin **barrel** — it `export *`s each domain module and
defines `MIRRORED_SCHEMAS`. Consumers import from the package root only (there
is no subpath `exports` map), so the internal split is invisible to them.

Modules, bottom-up (a file may import only from ones above it — a clean DAG,
no cycles):

| Module | Owns |
|---|---|
| `base.ts` | primitives: `BrowserId`, `WindowBounds`, `Capabilities` + `CAPABILITY_KEYS` |
| `enrichment.ts` | the single-authoring tab/window enrichment schemas, `TAB_ENRICHMENT_FIELDS`, `pickEnrichment`, `sanitizeFavicon`, `WindowState` |
| `page.ts` | page content & state — `PageState` (the one cross-cutting symbol, imported by wire + journal), extract/annotate I/O |
| `native.ts` | rust-accel shapes: `CgWindowInfo`, `DisplayInfo` (Rust-mirrored) |
| `contract.ts` | the daemon Snapshot contract: `Tab`/`BrowserWindow`/`BrowserState`/`Snapshot` |
| `wire.ts` | the extension ↔ daemon WebSocket protocol (`Ext*`) |
| `tools.ts` | MCP tool I/O schemas (noop/health/logs + tab/window commands + screenshots) |
| `journal.ts` | focus/nav journal records + `journal` tool I/O |
| `history.ts` | global browsing-history rows + `history` tool I/O |

## Invariants (guarded by tests — don't break them)

- **Barrel completeness** — every symbol must be re-exported from `index.ts`;
  consumers only ever import the root.
- **Rust drift mirror** — schemas listed in `MIRRORED_SCHEMAS` (kept in
  `index.ts`) must have matching field names in `apps/rust-accel/src/types.rs`.
  `tests/drift.test.ts` parses the Rust file and fails CI on divergence.
- **Single-authoring enrichment** — `TabEnrichmentSchema` is declared once (in
  `enrichment.ts`) and `.merge()`d into both the contract `Tab` and the wire
  `ExtTab`; `TAB_ENRICHMENT_FIELDS` must stay defined directly after it.
  `tests/enrichment.contract.test.ts` + the app/extension-core parity tests go
  red if a mapper drops a field.
- **Additive-optional** — new fields are optional/defaulted so `Snapshot`
  `version` need not bump; v2 stays a strict superset of v1.
