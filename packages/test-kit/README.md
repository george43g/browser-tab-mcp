# @george43g/test-kit

Shared test fixtures + fakes for the browser-tab workspace. Consumed as **raw
TS** (no build step, like `@george43g/vitest-config`) — Vitest transpiles it on
import, so it never joins the `^build` critical path.

## What lives here

Exactly two kinds of exports, nothing else:

1. **`make*` factories** — pure builders over `@george43g/shared-types` types,
   each taking a shallow `Partial<T>` override and nesting via composition
   (`makeBrowserState({ windows: [makeContractWindow({ tabs: [makeContractTab()] })] })`).
   - `factories/contract.ts` — daemon contract shapes: `makeSnapshot`,
     `makeBrowserState`, `makeContractWindow`, `makeContractTab`.
   - `factories/ext-wire.ts` — extension→daemon wire shapes: `makeExtSnapshot`,
     `makeExtWindow`, `makeExtTab`.
   - `factories/chrome-api.ts` — raw `chrome.*` INPUT shapes for the mappers:
     `makeChromeTab`, `makeChromeWindow` (+ `ChromeTabLike`/`ChromeWindowLike`).
2. **`install*` / `with*` global-lifecycle fakes** — each returns a handle with
   `restore()`.
   - `fakes/chrome.ts` — `installFakeChrome()`: a `chrome`-shaped fake with
     window/tab/runtime/storage/alarms registries, a call recorder (`.calls`),
     listener access (`.listener` / `.emit`), and `restore()`. Alarms are
     omittable to simulate Safari. Two APIs are **modelled, not stubbed**,
     because read-back is otherwise untestable: `windows.update` merges into a
     per-window overlay that `windows.get` observes, and `tabs.update` resolves
     the *seeded* tab so a caller reading `windowId` off the result lands on the
     window the tab is actually in (it falls back to a constant only when the
     test seeded no windows).
   - `fakes/daemon-env.ts` — `withDaemonEnv(tmp)`: sets/teardowns the 6-key
     `BROWSER_TAB_*` env block; plus `makeTmpDir()` and `randomWsPort()`.
     `randomWsPort` is not collision-proof across files — every integration
     file must claim its own disjoint `(base, span)` band (grep
     `randomWsPort(` under `apps/browser-tab-mcp/tests/` for the taken ones);
     files sharing a band red CI ~1 in 10 runs via swallowed-EADDRINUSE.
     `defaultIpcEndpoint(tmp)` (used internally by `withDaemonEnv`) is also
     exported standalone, for a caller that builds its own env block instead
     of going through `withDaemonEnv` — `apps/chrome-extension/e2e/fixtures.ts`
     imports it directly so the throwaway e2e daemon gets a real per-run
     `BROWSER_TAB_SOCKET_PATH` instead of falling back to the per-user default
     pipe/socket (the failure mode: a real daemon already running under that
     user silently absorbs the test's CLI calls).
   - `fakes/websocket.ts` (the `./node` subpath) — `installNodeWebSocket()`:
     `globalThis.WebSocket = ws.WebSocket`.

## Import surface

```ts
import { makeSnapshot, installFakeChrome } from "@george43g/test-kit";
import { installNodeWebSocket } from "@george43g/test-kit/node"; // pulls `ws`
```

The main barrel (`.`) has **zero runtime dependencies**; only the `./node`
subpath pulls `ws` (an optional peer). A package importing only factories +
`installFakeChrome` never drags `ws`.

## Keep it lean (rules)

- **Only the two export kinds above.** No assertions, no snapshots of real
  data, no domain logic — that belongs in the test that needs it.
- **No app imports, ever.** test-kit depends only on `@george43g/shared-types`
  (type-only) and `ws` (peer, `./node` only). Importing `extension-core` or
  `browser-tab-mcp` would create a cycle — those packages are test-kit's
  *consumers*.
- **A helper earns a place only when ≥2 packages need it.** One-off setup stays
  colocated in the test file.
