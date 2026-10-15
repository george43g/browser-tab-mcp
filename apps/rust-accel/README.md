# @george43g/rust-accel

Optional Rust acceleration for the `browser-tab-mcp` starter template.

## Build

```bash
pnpm --filter @george43g/rust-accel build         # release
pnpm --filter @george43g/rust-accel build:debug   # debug symbols
cargo test --release                              # unit tests
```

The build is **optional**. Consumers without a Rust toolchain (`cargo`)
get the JavaScript stub at `index.js` which throws on import; the parent
app's `tryLoadNative()` catches that and falls back to the TypeScript
implementation.

`MCP_DISABLE_NATIVE=1` forces the TS fallback even when the binary is built.

## Exports

| Function | Returns | Used by |
|---|---|---|
| `listCgWindows()` | every on-screen CoreGraphics window: id, owner pid, bounds, layer. **No titles**, because reading them needs Screen Recording consent | browser-tab (cgWindowId correlation) |
| `listCgWindowsOfPid(pid)` | the same, for one process, **with** `title` when consent exists | tmux-control (`list --processes`: which OS window a tmux client is in) |
| `listDisplays()` | displays with id and `isMain` | browser-tab |

`listCgWindowsOfPid` is the only call that reads window titles, so the consent
cost stays with the one consumer that needs it.

## Type contract

The Rust types in `src/types.rs` are **hand-mirrored** counterparts of
the Zod schemas in `@george43g/shared-types`. The drift-check test at
`packages/shared-types/tests/drift.test.ts` parses this file and fails
CI if a registered field is missing here.

When adding a field:

1. Add it to the Zod schema in `packages/shared-types/src/index.ts`.
2. Add it to the matching struct in `src/types.rs` (camelCase via serde
   rename if not already trivially matching).
3. Add it to the `MIRRORED_SCHEMAS` entry in shared-types.
4. CI's drift-check will pass.

## CI matrix

The default starter ships napi targets for darwin (x86_64 + aarch64),
linux (x86_64 + aarch64), and windows (x86_64). Adjust the `napi.targets`
array in `package.json` to match your distribution needs.
