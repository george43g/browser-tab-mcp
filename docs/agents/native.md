# Native Rust acceleration

Moved verbatim from `AGENTS.md` on 2026-09-24 (BACKLOG B28 reopened); "this file" in the text below means `AGENTS.md` as it was then.

## Native Rust acceleration (optional)

`apps/rust-accel/` contains a `napi-rs` v3 module. Build with `pnpm --filter rust-accel build`. The MCP loads it via `apps/browser-tab-mcp/src/native-bridge.ts:tryLoadNative()` and falls back to the TS implementation when missing.

Force TS path: `MCP_DISABLE_NATIVE=1`. CI tests both paths.

**The build is guarded, and CI cannot prove the guard.** rust-accel's `build`
script is `scripts/build-rust-optional.mjs`: no runnable `rustc` → logged skip,
exit 0 (turbo runs `rust-accel#build` on every root `pnpm build`, and an
unguarded `napi build` hard-failed the whole build on a rustless machine);
toolchain present but compile fails → the failure still propagates. Every
GitHub runner image — linux, macos AND windows — ships a preinstalled Rust
toolchain, so no CI leg ever exercises the skip path ("the harness is more
provisioned than the target" — CI cannot falsify an assumption it also
satisfies); the first machine that could was George's real
Windows box (2026-08-21). Both behaviours are pinned by
`apps/browser-tab-mcp/tests/build-rust-optional.test.ts`, which manufactures
both worlds via PATH. Turbo caveat: a cached skip replays until an input
changes — after installing Rust, `pnpm --filter rust-accel build` bypasses it.

Types are hand-mirrored between `packages/shared-types/src/index.ts` (Zod) and `apps/rust-accel/src/types.rs` (serde). The drift-check test in `packages/shared-types/tests/drift.test.ts` parses the Rust file and fails CI if field names diverge.
