# Rust acceleration

`apps/rust-accel/` is an optional napi-rs v3 module. The starter ships a working build pipeline and the canonical pattern; real tools fill in the domain-specific hot paths.

## When to use it

Rust is the right call when a hot path is:

- CPU-bound and called frequently (regex passes, parsers, format conversions)
- I/O-amplifying (SQLite over many rows, where Rust's `rusqlite` is dramatically faster than `better-sqlite3`)
- Binary-format-heavy (binrw, image decoding, etc)

Rust is **not** the right call when the work is dominated by network I/O — at that point the Node implementation is just as fast and you save the build complexity.

## Building

```bash
pnpm --filter @george43g/rust-accel build         # release
pnpm --filter @george43g/rust-accel build:debug   # debug symbols
cargo test --release                              # unit tests (run from apps/rust-accel/)
```

The build is **optional**. The top-level `pnpm build` calls `build:native:optional` which silently skips when `rustc` is missing. The starter app falls back to TypeScript automatically — `tryLoadNative()` returns null and `engineLabel()` returns `"ts"`.

Force the TS path even when the binary is built: `MCP_DISABLE_NATIVE=1`. CI tests both paths (`pnpm test` and `pnpm test:no-native`).

## Type contract (hand-mirrored)

Zod schemas in `packages/shared-types/src/index.ts` are the source of truth. Each one that's also implemented in Rust must:

1. Be registered in `MIRRORED_SCHEMAS` with the matching Rust struct name and expected fields.
2. Have a `#[napi(object)]` struct in `apps/rust-accel/src/types.rs`.
3. Use `#[napi(js_name = "camelCase")]` if the Rust field name differs from the camelCase TS form (Rust convention is snake_case).

The drift-check test at `packages/shared-types/tests/drift.test.ts` parses `types.rs` and fails CI when a registered field is missing.

## CI matrix

`apps/rust-accel/package.json` declares the `napi.targets`:

- `aarch64-apple-darwin` — M1/M2/M3 Macs
- `x86_64-apple-darwin` — Intel Macs
- `x86_64-unknown-linux-gnu` — Linux servers (most cloud runtimes)
- `aarch64-unknown-linux-gnu` — Linux ARM (Apple-silicon hosted runners, AWS Graviton)
- `x86_64-pc-windows-msvc` — Windows

Adjust the list to your distribution needs. To **drop Rust entirely**, see `docs/ARCHITECTURE.md#removing-surfaces`.

## Generated artifacts

After `napi build`:

- `apps/rust-accel/<binary>.node` — the platform-specific compiled module (gitignored)
- `apps/rust-accel/index.js` — the platform-aware require shim (overwrites the starter's placeholder)
- `apps/rust-accel/index.d.ts` — the generated typings (overwrites the starter's placeholder)

The starter ships hand-written placeholders for both `index.js` and `index.d.ts` so TS compilation works before the first build. Once you run `napi build`, the generated versions take over.

## Native-bridge pattern

The TS-side loader at `apps/browser-tab-mcp/src/native-bridge.ts` returns:

- The loaded module when the `.node` binary exists
- `null` when `MCP_DISABLE_NATIVE=1` is set
- `null` when the require fails for any reason

Callers never see thrown errors — `tryLoadNative()` swallows everything and returns null. This is the contract: Rust is acceleration, not correctness. The TS fallback path must always produce identical results.

Lifted from `imsg-mcp/src/native-bridge.ts` and generalized.
