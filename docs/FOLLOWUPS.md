# Follow-ups & decisions

Tracked next steps after the connector-extension + Safari work landed (PR #1,
`5a989b6`). The tool is complete and working end-to-end (daemon + Chrome +
Safari); these are hardening / productization items, not blockers.

> These were meant to be GitHub issues; `gh issue create` was timing out at the
> time, so they live here. Promote to issues when convenient (bodies are
> ready-to-paste below).

---

## 1. Test/CI hardening — make green meaningful for the browser extension

> **STATUS: DONE (2026-07-21).** Shipped: `@george43g/test-kit` (factories +
> `installFakeChrome`/`withDaemonEnv`/`installNodeWebSocket`, consumed by every
> package; the 4 hand-rolled builder clusters were retrofitted onto it); the
> real `DaemonSocket`↔`ExtensionServer` integration test (P1a), the messaging
> regression (P1b), the build-output guards (P1c), WS-protocol + snapshot
> contract tests, and extension-core unit tests (commands/events/runtime/options).
> Coverage is wired as a two-flag design (`COVERAGE=1` collects + uploads lcov;
> `COVERAGE_GATE=1` gates — **dormant**, we collect+report but don't gate yet).
> CI gained the coverage step, a shellcheck step, and a gated-off Playwright
> stub job; the stress harness now writes its report. Acceptance verified: the
> three sabotages below each turn a test RED. The taxonomy + "where a new test
> goes" decision tree now live in `AGENTS.md` (§ Testing posture & taxonomy).
> The sections below are the original plan, kept as the implementation record.
> **P3 Playwright E2E is now DONE** (full round-trip — see below). Still open
> here: coverage **gating** (flip `COVERAGE_GATE=1` in CI when the suite matures).

**Why.** CI green is meaningful for the daemon / MCP / kits (24 test files,
stress harness, both-OS build incl. Rust native) but **not** for the browser
extension — the layer that broke repeatedly this session. Concretely:

- `apps/chrome-extension` has **0 tests / no vitest config** — `background.ts`,
  `socket.ts`, messaging, popup/options never execute in a test.
- `ws-server.test.ts` drives a **hand-rolled fake client**, never the real
  `extension-core` `DaemonSocket` / `buildSnapshot` / `executeCommand`.
- **Nothing validates the built bundle** (manifest shape, IIFE-not-module,
  classic `<script>` tags).
- Coverage thresholds exist in `vitest-config` (shared 80/70/70/70, app
  50/40/40/40) but are **not enforced** — the script is bare `vitest run`
  (no `--coverage`).

None of this session's bugs (module SW, dual background, cross-browser
messaging, blank options) were catchable by the current suite.

**Current test inventory (orientation).** Tested: daemon/detect/client in
`apps/browser-tab-mcp/tests/{adapters,correlate,integration,daemon-ipc,ws-server,merge,ws-heartbeat}.test.ts`;
extension-core PURE logic in `packages/extension-core/src/{status,snapshot}.test.ts`.
Untested: the runtime wiring — `packages/extension-core/src/{socket,runtime,events,commands,options}.ts`
and all of `apps/chrome-extension/src/*`.

### P1a — real client↔server integration test (highest value)

Exercise the ACTUAL extension code against the ACTUAL daemon WS server in Node
— the seam `ws-server.test.ts` skips (it drives a hand-rolled JSON client).
Reuse that test's setup (it already `startDaemon()`s with `BROWSER_TAB_FAKE_ADAPTER=1`,
a temp socket, and an ephemeral `BROWSER_TAB_WS_PORT`); swap the fake client
for the real `DaemonSocket` from `@george43g/extension-core`.

The browser code needs two Node globals:

```ts
import { WebSocket as WsWebSocket } from "ws";
// socket.ts uses the global WebSocket + addEventListener + WebSocket.OPEN/CLOSED;
// `ws` exposes exactly that browser-compatible surface.
globalThis.WebSocket = WsWebSocket as unknown as typeof WebSocket;

// extension-core `api` proxy (runtime.ts) resolves globalThis.browser ?? globalThis.chrome.
// Minimal fake covering the calls the code makes (buildSnapshot + wireEvents + executeCommand):
const listener = { addListener() {} };
const fakeApi = {
  windows: {
    getAll: async () => [/* ChromeWindowLike fixtures: {id,focused,incognito,left,top,width,height,type:"normal",tabs:[...]} */],
    create: async () => ({ id: 9 }),
    onCreated: listener, onRemoved: listener, onFocusChanged: listener,
  },
  tabs: {
    onCreated: listener, onRemoved: listener, onUpdated: listener, onMoved: listener,
    onActivated: listener, onAttached: listener, onDetached: listener, onReplaced: listener,
    move: async () => ({}), update: async () => ({}), remove: async () => ({}),
    create: async () => ({ id: 1, windowId: 1 }),
  },
};
globalThis.chrome = fakeApi as unknown as typeof chrome;
```

Then `const sock = new DaemonSocket({ port, token, browser: "chrome", extVersion: "test" }); sock.start();`
and assert against the running daemon:
- **helloAck → snapshot**: `getSnapshot` (via `DaemonClient`) shows chrome
  `dataSource:"extension"` with `t:chrome:x…` handles — proves buildSnapshot +
  `mapWindows` + the WS protocol run for real.
- **bad token**: construct with a wrong token → daemon closes 4001 →
  `sock.getState().lastError` reflects it (the close-reason decoding).
- **command round-trip**: `daemon.ext.sendCommand("chrome","move_tab",{tabId})`
  → the real `executeCommand` (commands.ts) runs against `fakeApi` and returns
  a result the daemon maps to an x-handle.
- **disconnect**: `sock.stop()` (or terminate the daemon socket) → daemon
  `onDisconnect` → `clearExtension` → next `getSnapshot` is AppleScript.

This covers the WS protocol, snapshot mappers, command execution, and
reconnect — everything the current fake-client test can't.

### P1b — cross-browser messaging regression test

`background.ts installMessaging` branches on `globalThis.browser`. Register the
listener, then invoke it with `globalThis.browser` **defined** (assert it
RETURNS a promise resolving to a `ConnectorStatus`) and **undefined** (assert
it calls `sendResponse` and returns `true`). This is the exact bug that made
Safari's settings show "background worker isn't responding".

### P1c — static build-output guards (cheap, high-signal)

`apps/chrome-extension` has no vitest config — add one (mirror
`packages/extension-core/vitest.config.*`, use `@george43g/vitest-config`).
Add `tests/build-output.test.ts` that reads `dist/` after `pnpm --filter
@george43g/chrome-extension build`:
- `manifest.json`: `manifest_version===3`; `background.service_worker` AND
  `background.scripts` both present; `action.default_popup` set; every
  `icons` / `action.default_icon` path exists on disk.
- `background.js` / `options.js` / `popup.js`: no line matching `/^\s*import\b/`
  or `/^\s*export\b/`, no `import(`, and each starts with an IIFE
  (`(function(){`) — the Safari classic-script contract.
- `options.html` / `popup.html`: no `<script ... type="module">`.

Would have red-flagged every Safari build regression this session (the module
SW, the ES-chunk imports, the `type="module"` script tags).

### P2 — enforce coverage + shellcheck

- Flip the `test` script to `vitest run --coverage` (thresholds already in
  `vitest-config`: shared 80/70/70/70, app 50/40/40/40). **MUST land after
  P1** — today the new uncovered `socket.ts`/`log.ts` would fail the shared
  bar. Likely need to `coverage.exclude` the pure-browser-runtime files that
  can't be unit-tested (popup/options entry glue), or accept the P1 coverage.
- Add a `shellcheck apps/safari-extension/scripts/*.sh` CI step.

### P3 — Playwright headed-Chromium E2E — **DONE**

Shipped: `apps/chrome-extension/e2e/*.e2e.test.ts` (`@playwright/test`, its own
runner, excluded from the vitest unit run). Launches a persistent context with
`--disable-extensions-except=<dist>` + `--load-extension=<dist>` in **new-headless**
(the full chromium build, which supports MV3 extensions — the headless shell does
not), points it at a throwaway daemon isolated via `BROWSER_TAB_STATE_DIR`/
`_CACHE_DIR` (fake adapter, real WS), seeds the options config, asserts the daemon
goes **extension-authoritative** (`dataSource:"extension"`, x-handles) and that a
daemon-driven **cross-window move preserves scroll**. Own CI job (`e2e-chromium`).
Safari is NOT automatable — the README manual-smoke checklist stays.

### CI wiring (`.github/workflows/ci.yml`)

P1a/P1b/P1c run under the existing `pnpm test` / `pnpm test:no-native` steps
(all vitest); P1c needs `pnpm build` first (already runs before test). P2
changes the `test` script + adds a shellcheck step. P3 is a new job.

### Suggested order & acceptance

P1a + P1b + P1c first (all Node, no new infra) → P2 once P1 lifts coverage
over the bar → P3 only if the extension keeps churning. **Acceptance for
"green is meaningful":** deliberately (a) drop `background.scripts`, (b)
reintroduce `background.type:"module"`, or (c) make the messaging listener
Chrome-only — each must turn CI **red**.

**Out of scope (can't automate):** Safari runtime + packaging scripts
(Xcode/pluginkit / no headless Safari) — manual smoke only, documented in
`apps/safari-extension/README.md`.

---

## 2. npm publishing (deliberately NOT wired)

**Status update:** the *release* half of this item is **done** — release-please
is live (`docs/RELEASE.md`): tags, GitHub Releases and `CHANGELOG.md` on merge
of a rolling release PR. The orphaned semantic-release scaffold
(`.releaserc.json`, never a dependency) was deleted with it.

What remains open is only **distribution**, which was split off on purpose:
versioning must not be coupled to a registry. wm-stack consumes the built
`dist/cli.js` + the socket/JSON contract, so nothing needs npm today.

**If/when that changes**, it is an additive job — not a re-architecture:
- Publish surface = the bin package `@george43g/browser-tab-mcp` only (already
  `private: false`); keep internal `packages/*` private. Add
  `"publishConfig": { "access": "public" }`.
- Pin `name`/`bin`/`files`/`exports` for a clean tarball (CI already runs
  `npm pack --dry-run`).
- Add the `NPM_TOKEN` repo secret (publish scope).
- Add a `publish` job to `release.yml` gated on
  `needs.release-please.outputs.release_created == 'true'`. **Do not** bolt
  publishing onto the release-please step itself.
- Update install docs (`npx @george43g/browser-tab-mcp`).

**Note:** release-please reads Conventional Commits on `main`. Squash-merging
with a conventional PR title (this repo's pattern) lands one such title per PR
— fine for version determination.

---

## 3. Decision — monorepo strategy (revisit later)

**Chosen: keep browser-tab as its own JS monorepo; wm-stack consumes the
JSON/socket contract** (`docs/WM_STACK_CONTRACT.md`), not a code dependency.

Rationale: the broader stack is **polyglot** — TS here, bash/lua/Hammerspoon
in wm-stack, Rust (napi), Swift (Safari). A JS-centric monorepo tool
(Turbo/pnpm) manages *this* repo well but won't manage bash/lua at the
whole-stack layer. The JSON-over-socket contract is the right seam precisely
because it's language-agnostic — that decoupling is a feature, not debt.

**Revisit when:** 3+ interdependent tools need atomic cross-cutting changes.
At that point the pragmatic "multi-layer" path is **mise** (already adopted
here) as a polyglot task orchestrator over a flat workspace — not Nx/Bazel
unless scale genuinely demands it. Don't merge repos prematurely.
