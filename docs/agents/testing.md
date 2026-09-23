# Testing — posture, taxonomy, effect coverage, stress harness

Moved verbatim from `AGENTS.md` on 2026-09-24 (BACKLOG B28 reopened); "this file" in the text below means `AGENTS.md` as it was then.

## Testing posture & taxonomy

CI green now exercises the **browser-extension runtime too**, not just the daemon/MCP/kits. The layer that broke repeatedly (module SW, dual background, cross-browser messaging) is covered:

- **Integration** (`apps/browser-tab-mcp/tests/ext-socket.integration.test.ts`): the REAL `extension-core` `DaemonSocket` drives the REAL daemon `ExtensionServer` over loopback (`installNodeWebSocket` bridges `ws` onto `globalThis.WebSocket`; `installFakeChrome` backs `buildSnapshot`/`executeCommand`) — the seam `ws-server.test.ts`'s hand-rolled client skips.
- **Messaging regression** (`apps/chrome-extension/tests/messaging.test.ts`): asserts the `onMessage` listener returns a Promise under `globalThis.browser` (Safari/Firefox) and `sendResponse`+`true` under Chrome.
- **Build-output guards** (`apps/chrome-extension/tests/build-output.test.ts`): reads `dist/` — MV3, BOTH background keys, no `background.type:"module"`, IIFE-not-ESM entry JS, no `type="module"` script tags, every asset present.
- **Contract** (`packages/shared-types/tests/ws-protocol.contract.test.ts`, `apps/browser-tab-mcp/tests/snapshot.contract.test.ts`): WS message round-trips + `extSnapshotToBrowserState` shape/x-handle grammar.
- **e2e** (`apps/chrome-extension/e2e/*.e2e.test.ts`): the `e2e-chromium` job in `ci.yml` runs **unconditionally** — no gate, no `continue-on-error` — with the full Playwright suite — the enforced floor lives in `e2e/run-guard.ts` `EXPECTED_MIN_TESTS` (67 as of 2026-09-03; hard-coded counts here drifted twice, so the guard file is the number's home; see § Effect coverage below). Every one of them asserts against BOTH the daemon snapshot and the browser's own truth via `chrome.tabs.query` / `chrome.windows.get` in the extension's service worker, because a snapshot agreeing with itself is what a fake adapter already proves. Run it locally with `pnpm --filter @george43g/chrome-extension test:e2e`. **Windows legs**: `e2e-branded` (windows-latest, matrix `channel: [chromium, msedge]` via `E2E_BROWSER_CHANNEL`, headless) runs the SAME suite there — `chromium` (Playwright's own bundled build, one `playwright install` step) is the only CI coverage of the win32 daemon/named-pipe/e2e path, and `msedge` (real, preinstalled Windows Edge, no install step) is the standing regression test for `detectBrowserName`'s `edg/`-before-chrome UA ordering — `seedConfig` deliberately does not seed a `browser` key, so real auto-detection is what each leg exercises, and Edge evicting the Chrome WS session would show up here as a failure, not silently. **Not a `chrome` row**: branded Google Chrome ≥137 removed `--load-extension` support entirely (confirmed on both a real Windows box and a local macOS Chrome 151 — the load test times out waiting for the background service worker, which never registers); `chrome` stays a valid `E2E_BROWSER_CHANNEL` value in `fixtures.ts` for Chrome ≤136 or a future re-enable, it's just not in CI — branded-Chrome coverage, where it still matters, is a real-profile GUI install smoke instead. The throwaway daemon's IPC endpoint is pinned per-run via `BROWSER_TAB_SOCKET_PATH` (`defaultIpcEndpoint()` from `@george43g/test-kit`, imported by `fixtures.ts` rather than duplicated — it was a local `e2eIpcEndpoint` copy until #103) — without it, Windows falls back to the per-user default named pipe, and a dev box's already-running console daemon silently absorbs the test's CLI calls instead of the throwaway one (measured on the box, 2026-08-22).
- **Coverage**: collected + uploaded in CI (`COVERAGE=1`), **not gated yet** — arm with `COVERAGE_GATE=1` later.

Acceptance held when built: dropping `background.scripts`, reintroducing `background.type:"module"`, or making the messaging listener Chrome-only each turns a test RED.

### Effect coverage — the ledger, and why it is not a table in this file

**`docs/surfaces/effect-coverage.json` is the source of truth**, and
`apps/browser-tab-mcp/tests/surface-coverage.contract.test.ts` enforces it. The
ledger has one row per command surface — 20 registry tools + 11 CLI-only
commands = **31** — and the contract test enumerates that set from
`makeAppRegistry().tools` plus commander (`tests/helpers/cli-surface.ts`), never
from a hand-written list. Adding tool #21 turns it red on the next `pnpm test`.
Rows carry `app` (the directory under `apps/`); each MCP app checks its own rows
in its own `tests/surface-coverage.contract.test.ts`, and
`apps/browser-tab-mcp/tests/app-admission.contract.test.ts` fails when an MCP
app has no rows or lacks one of the per-app contract tests.

A prose table here would be a second copy that drifts, so this section states
the RULES and points at the file for the state.

| tier | runner | reaches |
|---|---|---|
| `chromium-e2e` | Playwright, `apps/chrome-extension/e2e/` | the built `dist/` in real Chromium/Edge + a throwaway daemon. Runs in CI on all three legs. |
| `cli-process` | vitest, `apps/browser-tab-mcp/tests/` | the built `dist/cli.js` spawned as a real process against a fake-adapter daemon. No browser. Runs in CI. |
| `macos-local` | `pnpm sweep:macos`, a developer's Mac only | real `osascript` / `screencapture` / Safari `History.db`. **Cannot run in CI** — GitHub's macOS runners have no logged-in GUI session, so `tell application` cannot work. |

**The `macos-local` tier is `scripts/sweep-macos.mjs`, and its constraints are
not incidental.** It drives the BUILT bin against a socket path with no daemon
behind it, so every call takes the `daemon_unreachable_falling_back` route into
the AppleScript adapters — that route *is* the thing under test. Three surfaces
(`journal`, `history`, `screenshot`) are daemon-only reads with no adapter
fallback, so they get a throwaway daemon on that same isolated socket.

- **Target selection is the whole safety model.** The adapter addresses a
  browser BY APP NAME (`tell application "…"`), and Apple Events route by app
  identity — not by pid, not by `--user-data-dir`. So Playwright-style
  isolation does not help: a second instance of the same bundle is not
  separately addressable however isolated its profile is. What is needed is a
  DIFFERENT BUNDLE. The sweep prefers **Google Chrome for Testing**, which
  Playwright already downloads (`~/Library/Caches/ms-playwright/chromium-*/`),
  reaches it via `BROWSER_TAB_CHROMIUM_APP_NAME`, and **refuses to start** if
  its chosen browser is already running. Google Chrome is excluded by
  construction and there is no flag to include it.
- **Homebrew's `chromium` cask does not work** — ad-hoc signed AND quarantined,
  so Gatekeeper blocks it and `open` returns a bare `-128`. Note the AND:
  macOS only assesses *quarantined* bundles, so Chrome for Testing launches
  fine despite failing the same `spctl` check. A preflight that consulted
  `spctl` alone would reject the one browser that works.
- **Safari is opt-in behind `--safari`** and runs under record/restore against
  the real browser (there is only one). Every window the sweep touches must be
  in its `owned` set, which it only adds to when it created the window.
- **A skip with a reason is a first-class outcome**, not a soft failure. Two
  are structural on a real desktop: `set_window` bounds cannot be verified
  under a tiling WM (yabai re-tiles the window the instant AppleScript moves
  it — measured, `{120,120,1020,820}` read back as `{-1297,-1030,563,-10}`),
  and the window-tier `screenshot` needs both a resolved `cgWindowId` and
  Screen Recording consent. The sweep reports the TCC state it finds and never
  grants or revokes one.
- **The report is committed** (`apps/browser-tab-mcp/sweep-macos-report.json`,
  redacted by construction: surface, pathway, status, reason, sha, browser
  build — never a URL, title or user path), and
  `surface-coverage.contract.test.ts` asserts every non-pending `macos-local`
  row has a PASSING row in it. That is the macos analogue of `run-guard.ts`,
  and it works where a reporter cannot precisely because the artifact is in
  git. Re-running on a machine where a surface newly skips turns that test red
  until the row goes back to `"pending"` — which is correct: the claim stopped
  being backed.
- **It is NOT wired to pre-push.** A push must not spawn browser windows.
  `focus_tab` and `set_window` genuinely steal focus; there is no way to verify
  them that does not.

**It exits 1 on this Mac today, and that is the honest answer, not a broken
harness.** One pathway is genuinely unproven: `tab_action back` cannot reliably
reach a history entry created through `tab_action navigate` (8 of 9 runs;
mechanism NOT understood — see BACKLOG **B20**, which records the measurements
rather than a guess). Everything else passes or skips with a stated reason. So
the useful reading of a sweep run is *"is there a failure other than B20?"* —
there is no known-issues allowlist, deliberately, because that is how a known
issue stops being read.

**One plan assumption it falsified.** The plan predicted a Chromium
"close+reopen" move to verify; `chromium.ts` `moveTab` does no such thing — it
throws unconditionally, because close+reopen loses session state and shipping
that silently would be worse than refusing. The ledger row now records the
REFUSAL as the contract, which is what the code actually promises.

Three rules the ledger encodes, all of which have been violated before:

1. **`tier` is where a surface's EFFECT is proved** — that a browser actually
   did the thing. `installFakeChrome` and `BROWSER_TAB_FAKE_ADAPTER=1` both
   stand in for a browser; neither IS one, so neither counts. Before the sweep,
   2 of 31 surfaces were effect-verified and 21 were dispatch-only.
2. **A surface appears on more than one tier when it has more than one
   PATHWAY.** `focus_tab` through the extension and `focus_tab` through
   AppleScript are different code with different bugs, and the Chromium suite
   cannot reach the second by construction. 14 surfaces carry a `macos-local`
   row for exactly this reason.
3. **`evidence` is a path or the literal `"pending"`, and a non-pending
   `chromium-e2e` entry is a CLAIM that gets enforced.**
   `e2e/run-guard.ts` (a Playwright reporter) fails the run unless a PASSING
   test carried a matching `surface` annotation. It reads annotations off the
   RESULT, so a test that asserts a surface and then fails proves nothing; and
   it fails the inverse too, so a test cannot land without its ledger row being
   flipped in the same PR. The guard only ever turns green into red — on an
   already-failed run it reports and decides nothing, so cascade noise cannot
   bury Playwright's own diagnostics.

**What this bought, concretely.** The sweep found a real defect in its first
week that five months of unit tests did not: `focus_tab` through the extension
relied on Chrome un-minimizing as a SIDE EFFECT of `{focused:true}`, which does
not always fire — a focused tab inside a window the user cannot see, and the
exact bug the AppleScript pathway had already been fixed for (#106). It also
reproduced the 2026-08-20 group-relocation bug against real Chrome for the
first time, where the fix had only ever been proven against a fake stub's model
of the surprise.

**Traps this tier has, that the others do not** (all measured, all in the
relevant file's header):

- The throwaway e2e daemon runs the fake AppleScript adapter, so its snapshot
  ALWAYS contains fabricated brave/chromium/safari windows. Narrow to the run's
  browser via `stack.browserState()`; a spec that scans `snap.browsers` is
  measuring the fixture, successfully.
- A tab created by a daemon COMMAND is pushed to the snapshot immediately; one
  created out of band via `sw.evaluate` arrives debounced. Use
  `stack.waitForTab()`, not `tabs.get(id).status === "complete"` — that is the
  browser's opinion about a different process.
- Environment-dependent behaviour goes BOTH ways across legs. Headless Chromium
  never restarts a reloaded service worker; real Windows Edge restarts it too
  fast to observe the drop. Assert the invariant, not either observation.

**Where a new test goes** — four layers:

| Layer | Lives | Naming | May touch |
|---|---|---|---|
| unit | colocated `src/**/*.test.ts` | `<module>.test.ts` | one module's logic; fakes ok, no sockets/FS/daemon |
| integration | `tests/*.test.{ts,tsx}` | `<feature>.test.ts` | real components wired (daemon+client, `DaemonSocket`↔`ExtensionServer`, daemon↔TUI render), temp FS, loopback WS |
| contract | `tests/*.contract.test.ts` | `.contract.test.ts` | schema/wire invariants two implementations must agree on |
| e2e | `apps/chrome-extension/e2e/*` | `.e2e.test.ts` | built `dist/` in a real headless Chromium/Chrome/Edge + a throwaway HOME-isolated daemon (Playwright) |

Decision tree: pure logic → unit (colocated). Crosses a process/socket/FS boundary or wires 2+ real components → integration (`tests/`) with `withDaemonEnv` + `installFakeChrome`/`installNodeWebSocket` from `@george43g/test-kit`. Defines a shape another implementation must match (Rust struct, WS wire, MCP tool I/O) → contract. Needs a real browser actually running the bundle → e2e (`e2e/fixtures.ts` gives you `startDaemon`/`launchExtension`/`seedConfig`). **DOM-touching test → add `// @vitest-environment happy-dom` at the top** (default env is node so `socket.ts` timer tests stay DOM-free).

**Both roots collect `.ts` AND `.tsx`** (`packages/vitest-config/vitest.shared.ts`). A too-narrow `include` doesn't fail — it discovers nothing, so the tests never report. That has now bitten twice: `src/` once (TUI render tests silently ran zero), then `tests/`, where an Ink/React integration test sat uncollected in exactly the directory this taxonomy prescribes. Don't narrow the globs back.

**Fixtures live in `@george43g/test-kit`** — `make*` factories + `install*`/`with*` global-lifecycle fakes only; never import an app (cycle). Add a helper there only when ≥2 packages need it. See `packages/test-kit/README.md`.

Still deferred: Safari runtime + packaging scripts can't be automated (no headless Safari / Xcode-in-CI) — manual smoke only (`apps/safari-extension/README.md`). Chromium E2E is **not** deferred; it is a real, always-on CI job (above). Release/npm enablement + the monorepo decision live in `docs/FOLLOWUPS.md`.

## Stress harness

`pnpm stress` covers 14 cases (in `apps/browser-tab-mcp/scripts/stress-mcp.ts`):

1. handshake + tools/list returns the full catalog
2. `health_check` returns `Status: healthy`
3. 20 parallel `health_check` calls all stay healthy
4. unknown tool name is rejected
5. malformed schema input returns a usable error
6. `MCP_TOOL_TIMEOUT_FORCE_MS=1` triggers a clean timeout
7. graceful shutdown exits 0 — SIGTERM on POSIX; stdin EOF on win32 (no catchable SIGTERM there)
8. `MCP_MAX_RSS_MB=50` triggers a watchdog kill
9. `list_tabs` with `BROWSER_TAB_FAKE_ADAPTER=1` returns a valid snapshot
10. `journal` with `BROWSER_TAB_FAKE_ADAPTER=1` returns a valid empty result
11. write-side tools under `BROWSER_TAB_FAKE_ADAPTER=1`: `tab_action navigate` / `open_window` / `close_window` return ok; `focus_tab` raises when `raiseWindow` is omitted (the Zod default surviving dispatch) and doesn't when it's `false`; `group_tabs` + an extension-only `tab_action` error cleanly
12. content + screenshot + history tools under `BROWSER_TAB_FAKE_ADAPTER=1`: `get_page` / `annotate` / `screenshot` error cleanly (all daemon/extension-only), `screenshot` with neither/both ids is schema-rejected, and `history` returns a valid empty result (daemon-only read, degrades like `journal`) + rejects an out-of-range `maxResults`
13. daemon lifecycle: IPC answers (probed by connecting — a named pipe has no fs entry) and serves 20 parallel getSnapshot; POSIX adds SIGTERM-exits-0 + socket-unlink, win32 asserts prompt termination
14. the two refusals that are security boundaries, over the real transport: `open_tab`/`open_window`/`tab_action navigate` reject `javascript:`/`file:`/`data:` and still accept `https:`; `get_logs` answers "Unknown tool name" without `MCP_DEV`

Add a case whenever you ship something touching lifecycle, dispatch, error handling, or transport.
