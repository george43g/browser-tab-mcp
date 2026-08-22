# R8 — Corrections to claims made BEFORE this research ran

These void earlier statements of mine. Recorded separately so the brief cannot inherit them.

## C1. "My two probe scripts become tests" — WRONG, there is only one, and HTTP is already tested

I claimed in the 2026-08-22 assessment (item 3, the e2e-structure answer George pasted back)
that the sweep suite's transport family would absorb "MCP stdio + HTTP — my two probe scripts
become tests". R4 searched the repo and the scratchpad exhaustively and found:

- **only ONE probe script exists**: `mcp-probe.mjs` (stdio MCP JSON-RPC — initialize /
  tools/list / health_check / list_tabs / get_logs dev-gate / open_tab url-policy). It has
  **zero assertions**, a hardcoded Windows CLI path, no env isolation, no cleanup.
- **the HTTP surface is ALREADY a committed test**:
  `apps/browser-tab-mcp/tests/http-interface.integration.test.ts`.

**Consequence for the plan:** the transport family is smaller than I said. HTTP is
already-tested infrastructure to EXTEND, not an ad-hoc script to promote. Only the stdio
probe needs turning into a real test, and "turning it into a test" means writing the
assertions it never had — it is a transcript, not a test.

## C2. "The back/forward no-op bug" is NOT an open bug — it is expected behaviour

R4's report refers to "the already-open, unresolved `act back`/`forward` no-op bug". That was
true when the research prompt was written but is now stale, and the brief must not carry it:

- `back` was verified working on George's REAL Edge tab across two gestured hops
  (better-firebase-functions → github.com/george43g → browser-tab-mcp#tools).
- `forward` was verified working on the same tab immediately after, walking back up the chain.
- Cause of the apparent no-op: Chromium's history-manipulation intervention marks gestureless
  entries (which the tool's own `navigate` creates) as skippable, and `goBack` honours it.

**Consequence for the plan:** back/forward is not a bug to fix. It is a BEHAVIOUR TO PIN —
the test must build history with a real gesture, and it should also assert the gestureless
case still skips, so the intervention's behaviour is documented in CI rather than rediscovered.

## C3. "e2e/** isn't typechecked" — CONFIRMED, and stronger than I claimed

I said e2e was "outside the chrome-extension tsconfig include". R3 proved it empirically:
`include: ["src/**/*.ts", "vite.config.ts"]`, and `tsc --listFiles` lists **zero** files under
`e2e/`. Playwright transpiles via esbuild and never invokes `tsc`, so e2e code is typechecked
**nowhere in the repo**, not merely excluded from one package's config. A type error in a
fixture cannot fail CI today.
