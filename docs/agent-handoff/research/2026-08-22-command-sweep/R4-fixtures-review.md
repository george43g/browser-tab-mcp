# R4 — Structural review of existing e2e test scaffolding

Scope: `apps/chrome-extension/e2e/fixtures.ts`, its two consumer test files, two
ad-hoc probe scripts, and `packages/test-kit`. No design opinions beyond Q5.

---

## Q1 — `apps/chrome-extension/e2e/fixtures.ts` (193 lines, read in full)

### Exported API (verbatim signatures)

```
apps/chrome-extension/e2e/fixtures.ts:23   export const DIST = resolve(HERE, "../dist");
apps/chrome-extension/e2e/fixtures.ts:24   export const REPO_ROOT = resolve(HERE, "../../..");
apps/chrome-extension/e2e/fixtures.ts:25   export const CLI = resolve(REPO_ROOT, "apps/browser-tab-mcp/dist/cli.js");
apps/chrome-extension/e2e/fixtures.ts:32   export const CHANNEL = RAW_CHANNEL;                    // "chromium" | "chrome" | "msedge", from E2E_BROWSER_CHANNEL
apps/chrome-extension/e2e/fixtures.ts:34   export const EXPECTED_BROWSER: "chrome" | "edge" = CHANNEL === "msedge" ? "edge" : "chrome";

apps/chrome-extension/e2e/fixtures.ts:37-48
export interface Daemon {
  proc: ChildProcess;
  wsPort: number;
  token: string;
  env: NodeJS.ProcessEnv;
  cli(args: string[]): Promise<string>;
  status(): Promise<Record<string, unknown>>;
  stop(): Promise<void>;
}

apps/chrome-extension/e2e/fixtures.ts:59   export async function startDaemon(): Promise<Daemon>

apps/chrome-extension/e2e/fixtures.ts:143-147
export async function launchExtension(): Promise<{
  context: BrowserContext;
  extensionId: string;
  userDataDir: string;
}>

apps/chrome-extension/e2e/fixtures.ts:168-172
export async function seedConfig(
  context: BrowserContext,
  extensionId: string,
  daemon: Daemon,
): Promise<void>

apps/chrome-extension/e2e/fixtures.ts:192   export const test = base;                 // re-export of Playwright's base test, untouched
apps/chrome-extension/e2e/fixtures.ts:193   export { expect } from "@playwright/test";
```

There is no custom Playwright `test.extend()` fixture object — `test` is the
bare `base` from `@playwright/test`. All setup/teardown wiring
(`startDaemon`/`launchExtension`/`seedConfig`/`stop`) is manual, called from
each spec's own `test.beforeAll`/`afterAll`, not injected as Playwright
fixtures. A new suite inherits nothing automatically; every new spec file
re-does the `beforeAll`/`afterAll` wiring by hand, copy-pasting the pattern in
`roundtrip.e2e.test.ts`.

### Daemon isolation mechanism (quoted)

```
apps/chrome-extension/e2e/fixtures.ts:1-9
/**
 * Playwright fixtures for the browser-tab extension e2e.
 *
 * Loads the BUILT `dist/` bundle into a real Chromium (new-headless — the full
 * chromium build supports MV3 extensions, the headless shell does not) and,
 * when a test needs the round-trip, spins up a throwaway daemon whose state is
 * fully isolated via `BROWSER_TAB_STATE_DIR`/`_CACHE_DIR` (never touches the
 * real `~/.browser-tab`). The daemon runs the fake AppleScript adapter, so the
 * only real browser in the loop is the one Playwright drives.
 */
```

```
apps/chrome-extension/e2e/fixtures.ts:60-88
  const dir = mkdtempSync(join(tmpdir(), "bt-e2e-"));
  const wsPort = ephemeralPort();
  ...
  const shared: NodeJS.ProcessEnv = {
    ...process.env,
    BROWSER_TAB_STATE_DIR: join(dir, "state"),
    BROWSER_TAB_CACHE_DIR: join(dir, "cache"),
    BROWSER_TAB_WS_PORT: String(wsPort),
    BROWSER_TAB_SOCKET_PATH: defaultIpcEndpoint(dir),
    MCP_LOG_DIR: join(dir, "logs"),
  };
  const daemonEnv: NodeJS.ProcessEnv = { ...shared, BROWSER_TAB_FAKE_ADAPTER: "1" };
```

Isolation = a fresh `mkdtempSync` dir per `startDaemon()` call, carrying
state/cache/log dirs, an ephemeral WS port, and — critically —
`BROWSER_TAB_SOCKET_PATH` explicitly set via `defaultIpcEndpoint(dir)`
(imported from `@george43g/test-kit`), not left to the per-user default. Note
this is NOT `$HOME`-based (no `HOME=` override anywhere in this file) — it's
purely env-var path isolation. The doc comment at the top calling it
"HOME-isolated" (also echoed in `roundtrip.e2e.test.ts:3`) is describing the
*effect* (never touches the real `~/.browser-tab`), not the literal mechanism.

Why the socket path matters, quoted in full because it encodes a measured
failure:

```
apps/chrome-extension/e2e/fixtures.ts:62-75
  // Shared isolation: state/cache/log dirs + WS port + IPC endpoint, never
  // the real ~/.browser-tab and never the per-user default pipe/socket. The
  // socket path matters most on Windows: leaving it unset falls back to the
  // per-user default named pipe, and a real daemon already running under
  // that same user (a dev's console session) silently absorbs every
  // `daemon.cli([...])` call below instead of the throwaway one — the
  // extension still connects to the throwaway fine, but the assertions read
  // the wrong daemon's state. Measured on the Windows box (2026-08-22):
  // `daemon status` returned a different pid, ws 8790, uptime 50min — which
  // is why the msedge roundtrip failed there. `defaultIpcEndpoint()` is
  // imported from `@george43g/test-kit` (an existing devDependency here,
  // same as the vitest unit tests use) rather than duplicated — see its doc
  // comment in `packages/test-kit/src/fakes/daemon-env.ts` for the full
  // rationale.
```

Also note the daemon-vs-client env split (easy to miss, load-bearing):

```
apps/chrome-extension/e2e/fixtures.ts:84-88
  // The DAEMON runs the fake AppleScript adapter (so it never shells osascript);
  // CLIENT calls must NOT — in fake mode `list`/`move` short-circuit to fake data
  // instead of querying the running daemon (whose chrome feed is the real extension).
  const daemonEnv: NodeJS.ProcessEnv = { ...shared, BROWSER_TAB_FAKE_ADAPTER: "1" };
  const env = shared;
```

The `Daemon.cli()`/`status()` methods use `env` (no `BROWSER_TAB_FAKE_ADAPTER`),
the spawned `daemon run` process uses `daemonEnv` (with it). A new suite that
carelessly reuses one env object for both would silently start reading fake
data instead of the real extension feed.

### Port collision avoidance (quoted — and its explicit limit)

```
apps/chrome-extension/e2e/fixtures.ts:50-57
/**
 * Pick a port deterministically-ish from the pid to avoid collisions in a serial run.
 * Base 24_500: 21500-23899 now belongs to the vitest integration bands — see
 * `randomWsPort(` callers and `packages/test-kit/src/fakes/daemon-env.ts`.
 */
function ephemeralPort(): number {
  return 24_500 + (process.pid % 2000);
}
```

Port band: **24500–26499**, explicitly kept disjoint from vitest's
21500–23899 integration bands (per the comment; not independently verified
here beyond the comment itself — the vitest bands live in
`apps/browser-tab-mcp/tests/*`, out of scope for this review). `ephemeralPort`
is NOT exported — private to this file. It is **pid-derived, not file-derived**
and the comment says "in a serial run" — this file has no per-spec-file band
concept analogous to vitest's (see Q5).

The Playwright config that governs how "serial" that assumption actually is:

```
apps/chrome-extension/playwright.config.ts
  fullyParallel: false,
  workers: 1,
```

So today, every `.e2e.test.ts` file in the project runs in the **same worker
process** (same pid), one after another — which is exactly the condition
`ephemeralPort()`'s comment assumes. It has not been exercised under
`workers > 1`.

### `seedConfig` — what it writes and deliberately omits (quoted)

```
apps/chrome-extension/e2e/fixtures.ts:167-190
/** Seed the extension's storage with the daemon's port + token (the real config path). */
export async function seedConfig(
  context: BrowserContext,
  extensionId: string,
  daemon: Daemon,
): Promise<void> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/options.html`);
  // Drive storage.local directly — the same keys the options form writes
  // (`token`/`port`), so the background reconnects on storage.onChanged.
  // Deliberately omit `browser`: real UA auto-detection (`detectBrowserName`,
  // extension-core runtime.ts) is what's under test here, and the msedge leg
  // is the standing regression guard for the edg/-before-chrome ordering that
  // keeps Edge from evicting the Chrome WS session.
  await page.evaluate(
    ({ token, port }) =>
      (globalThis as unknown as { chrome: typeof chrome }).chrome.storage.local.set({
        token,
        port,
      }),
    { token: daemon.token, port: daemon.wsPort },
  );
  await page.close();
}
```

Writes exactly two `storage.local` keys: `token`, `port`. Deliberately **does
not** write `browser` — the comment states this is on purpose, so real
UA-based auto-detection stays under test (this is the mechanism the msedge CI
leg depends on to catch a Chrome/Edge WS-session-eviction regression). A new
suite that "helps" by also seeding `browser` for determinism would silently
disable that regression guard.

### Teardown/cleanup — present, and its robustness

- `Daemon.stop()` (fixtures.ts:132-137): `SIGTERM` → wait 500ms → `SIGKILL` if
  still alive → `rmSync(dir, {recursive:true, force:true})`. Force-removes the
  temp dir unconditionally, so leftover state doesn't linger even if the
  daemon didn't shut down cleanly.
- `startDaemon()` itself has a **failure-path cleanup**: if the daemon never
  becomes reachable within 15s, it force-kills and force-removes the temp dir
  before throwing (fixtures.ts:122-126), so a startup failure doesn't leak a
  process/dir.
- Callers are responsible for invoking `stop()`/`context.close()` — the file
  provides no automatic fixture-level teardown (no `test.afterEach`/`use()`
  wrapper). In `roundtrip.e2e.test.ts` this is done in `test.afterAll` with
  optional chaining (`context?.close()`, `daemon?.stop()`) — robust to a
  `beforeAll` that threw partway through. In `load.e2e.test.ts` it's a
  `try/finally` around a single test body — robust to that test failing.
  Neither pattern is enforced by the fixtures module itself; a new spec file
  that forgets teardown (e.g., omits the `finally`/`afterAll`) leaks a
  Chromium process, a spawned daemon, and a temp dir, with nothing in
  `fixtures.ts` to catch that omission.

### Single-file / single-context assumptions

Yes, this is exercised only for one file today. Concretely:
- `ephemeralPort()` is pid-derived, not scoped to a spec file — see Q5.
- No helper exists for running two daemons or two browser contexts
  concurrently within one process; `startDaemon()`/`launchExtension()` are
  each stateless factories, so nothing *prevents* calling them twice, but
  nothing coordinates port/dir disjointness across two concurrent calls
  either (a second concurrent `startDaemon()` in the same pid would compute
  the identical `ephemeralPort()` value and collide on `listen`).
- The Playwright config (`workers: 1`, `fullyParallel: false`) is the reason
  this has never surfaced: today there is exactly one call site
  (`roundtrip.e2e.test.ts`'s single `describe.beforeAll`) actually invoking
  `startDaemon()`, and Playwright never runs two files' `beforeAll`s
  concurrently under this config.

---

## Q2 — The existing 3 tests (2 files, read in full)

### `load.e2e.test.ts` (29 lines) — 1 test, browser-only assertions

Test: `"loads the built extension and renders its options page"`
(load.e2e.test.ts:10).

Purpose stated in the file header:

```
load.e2e.test.ts:1-6
/**
 * Smoke: the BUILT bundle loads in a real (new-headless) Chromium — the layer
 * that broke repeatedly (module SW, dual background, type=module tags) and that
 * no unit test can prove. Asserts the background registers (we get an extension
 * id from its service worker) and the options page renders without console errors.
 */
```

Assertions (all Playwright/browser-side — no daemon, no CLI call anywhere in
this file):

```
load.e2e.test.ts:13    expect(extensionId).toMatch(/^[a-p]{32}$/);
load.e2e.test.ts:22    await expect(page.locator("body")).toBeVisible();
load.e2e.test.ts:23    expect(errors, `options page console errors: ${errors.join(" · ")}`).toEqual([]);
```

`errors` is collected via `page.on("console", ...)` (load.e2e.test.ts:17-19)
filtering `m.type() === "error"`. This test never touches the daemon.

### `roundtrip.e2e.test.ts` (136 lines) — 2 tests inside one serial `describe`

Header, stating the purpose explicitly ("dual-truth" is exactly what this
does):

```
roundtrip.e2e.test.ts:1-8
/**
 * Full round-trip: the BUILT extension in a real (new-headless) Chromium
 * connects to a throwaway, HOME-isolated daemon over loopback, and a daemon-
 * driven cross-window move executes via `chrome.tabs.move` — preserving the
 * page's scroll position (the crown-jewel behavior vs a state-losing
 * close+reopen). This is the one test that proves hello→helloAck→snapshot and
 * the command path end-to-end through a real browser.
 */
```

`test.describe.configure({ mode: "serial" })` (roundtrip.e2e.test.ts:26) forces
its two tests to run in declared order within this file (on top of the
project-level `workers:1`).

**Test 1** — `"the daemon serves the real extension's tabs with x-handles"`
(roundtrip.e2e.test.ts:68) — **daemon-side only**, via CLI reading the
daemon's snapshot, never inspects the browser directly:

```
roundtrip.e2e.test.ts:69-83
    const snap = JSON.parse(await daemon.cli(["list", "--json"]));
    const chrome = (snap.browsers as Array<Record<string, unknown>>).find(
      (b) => b.browser === EXPECTED_BROWSER,
    );
    expect(chrome, `${EXPECTED_BROWSER} browser present in snapshot`).toBeTruthy();
    expect(chrome?.dataSource).toBe("extension");
    expect(chrome?.extensionConnected).toBe(true);
    expect(chrome?.running, "live extension feed must mean running=true").toBe(true);
    const windows = (chrome?.windows ?? []) as Array<Record<string, unknown>>;
    expect(String(windows[0]?.windowId)).toMatch(new RegExp(`^w:${EXPECTED_BROWSER}:x\\d+$`));
```

**Test 2** — `"a daemon-driven cross-window move preserves scroll"`
(roundtrip.e2e.test.ts:85) — **both** daemon-side (CLI/snapshot) AND direct
browser-side (Playwright `evaluate`) assertions, in the same test:

Browser-side (creates windows via a raw `chrome.windows.create` call through
the service worker, scrolls a real page, and reads `window.scrollY` back
through Playwright, twice — before and after the daemon-driven move):

```
roundtrip.e2e.test.ts:87-95
    const ids = await sw.evaluate(async (tall) => {
      const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      const w1 = await c.windows.create({ url: tall, focused: true });
      const w2 = await c.windows.create({ url: "about:blank" });
      return { tallTabId: w1.tabs?.[0]?.id as number, win2Id: w2.id as number };
    }, TALL);
...
roundtrip.e2e.test.ts:103-104
    await tallPage.evaluate((y) => window.scrollTo(0, y), SCROLL_Y);
    expect(await tallPage.evaluate(() => Math.round(window.scrollY))).toBe(SCROLL_Y);
...
roundtrip.e2e.test.ts:134    expect(await tallPage.evaluate(() => Math.round(window.scrollY))).toBe(SCROLL_Y);
```

Daemon-side (the command itself, and its effect, both go through the CLI):

```
roundtrip.e2e.test.ts:107-111
    const tabHandle = `t:${EXPECTED_BROWSER}:x${ids.tallTabId}`;
    const targetWindow = `w:${EXPECTED_BROWSER}:x${ids.win2Id}`;
    await daemon.cli(["move", tabHandle, "--target-window", targetWindow]);
...
roundtrip.e2e.test.ts:114-131  (poll on daemon.cli(["list","--json"]) until the
    tab appears under targetWindow — daemon-snapshot assertion)
```

So: **`load` = browser-only. `roundtrip` test 1 = daemon-only. `roundtrip`
test 2 = both**, deliberately (daemon snapshot proves the move committed;
Playwright-side `scrollY` proves it was a real `chrome.tabs.move`, not a
close+reopen — the "crown-jewel behavior" the header names). This dual-truth
pattern is not abstracted into a fixtures.ts helper — it's hand-rolled in this
one test.

---

## Q3 — The two ad-hoc probe scripts

### Found: `mcp-probe.mjs`

Location: `/private/tmp/claude-501/.../scratchpad/mcp-probe.mjs` (53 lines,
mtime 2026-08-22 14:23, this session). Not present anywhere in the repo
(searched `apps/`, `scripts/`, git-tracked and untracked/ignored).

What it probes: raw MCP JSON-RPC over stdio against the built CLI's `mcp`
subcommand. Header:

```
mcp-probe.mjs:1
// MCP stdio probe: initialize → tools/list → health_check → list_tabs(edge) → screenshot(image block?)
```

It spawns `node <CLI> mcp` (mcp-probe.mjs:3-4, `CLI` hardcoded to a **Windows
path**: `C:\Users\georg\repos\browser-tab-mcp\apps\browser-tab-mcp\dist\cli.js`
— this ran on the Windows box, not portable as-is), then issues, in order:
`initialize` → `notifications/initialized` → `tools/list` → `tools/call
health_check` → `tools/call list_tabs {browser:"edge", fields:"summary"}` →
`tools/call get_logs` (dev-gate check) → `tools/call open_tab
{url:"javascript:alert(1)", browser:"edge"}` (URL-policy refusal check).

**What it asserts: nothing.** Every result is `console.log`'d
(`mcp-probe.mjs:33,37,40,44,47,50`), not compared against an expected value —
this is a human-read transcript, not a test. There is no `assert`/`expect`
anywhere in the file.

What it would take to become a real test:
- **Assertions**: every `console.log` line needs a real `expect(...)` (e.g.
  tool count/names from `tools/list`, `"healthy"` substring from
  `health_check`, dev-gate error text from `get_logs`, url-policy refusal text
  from `open_tab`).
- **Portability**: the hardcoded Windows `CLI` path must become the
  `CLI`/`REPO_ROOT` pattern already established in `fixtures.ts:23-25`.
- **Isolation**: it sets **no** `BROWSER_TAB_*` env at all — it inherits
  `process.env` wholesale, meaning `list_tabs`/`health_check`/`open_tab` here
  ran against the box's **real, already-running daemon** (real Edge). That
  was appropriate for manual verification; it is not appropriate for CI —
  needs the same throwaway-daemon-env wiring `startDaemon()` provides (or a
  fake-adapter env, since this is exercising MCP-over-stdio behavior, not
  browser behavior — it may not need a real browser/daemon at all, just
  `BROWSER_TAB_FAKE_ADAPTER=1` plumbed to the child).
- **Error handling**: `call()` rejects on a 20s timeout
  (mcp-probe.mjs:23) with no `.catch` anywhere in the top-level `await` chain
  — an unhandled rejection would currently crash the script uncleanly rather
  than fail a test assertion.
- **Cleanup**: `p.kill()` (mcp-probe.mjs:52) with no try/finally — a thrown
  assertion earlier in the script would leave the child process running.
- **Placement**: this is process-spawn + stdio JSON-RPC against the built
  bin, closest in shape to `apps/browser-tab-mcp/scripts/stress-mcp.ts`'s
  cases (per CLAUDE.md's stress-harness list) or a new
  `apps/browser-tab-mcp/tests/*.integration.test.ts` — not naturally an
  `e2e/*.e2e.test.ts` (no real browser or extension involved at all; MCP-over-
  stdio doesn't need Playwright).

### NOT found: a second script exercising the HTTP interface

I searched the full repo (tracked, untracked, and `git status --ignored`) and
the entire scratchpad tree (including `bak/`, `bak2/`, `tmux-archive/`,
`briefs/`, and every `.mjs`/`.cjs`/`.ts`/`.sh`/`.log` file) for anything
issuing HTTP requests against the daemon's `/snapshot`, `/events`,
`/tools/:name`, or `/health` routes (grepped for `curl`, `EventSource`,
`Invoke-RestMethod`, `Invoke-WebRequest`, `fetch(`, `MCP_HTTP`,
`Authorization: Bearer`, `BROWSER_TAB_HTTP`). **No such script exists in
either location.**

What I found instead, for context — do not conflate these with a probe
script:
- `apps/browser-tab-mcp/src/daemon/http-server.ts` (218 lines) — the real
  HTTP interface implementation (opt-in via `BROWSER_TAB_HTTP_PORT`, PR #67
  per `docs/agent-handoff/BACKLOG.md:165`).
- `apps/browser-tab-mcp/tests/http-interface.integration.test.ts` (184
  lines) — an **already-real, already-committed** integration test (last
  touched by `#90`, `git log`), exercising this HTTP interface. This is not
  an "ad-hoc probe" candidate — it already IS a proper test in the taxonomy.
- `scratchpad/http.bak` — an editor backup of `http-server.ts` mid-edit (has
  the same header comment as the real source file), not a probe.
- `docs/agent-handoff/PROGRESS-LOG.md`'s 2026-08-22 "later still" entry
  records that the HTTP interface WAS manually verified during the Windows-box
  sweep — `"HTTP interface (Bearer-only auth: 401 tokenless, /snapshot,
  /tools/noop dispatch, /health, 404; port down again after baseline
  restart)"` — but no script artifact for that verification survived to disk
  in this repo or scratchpad; it was most likely typed ad hoc (curl or
  PowerShell `Invoke-RestMethod`) directly into a remote tmux session on the
  Windows box and never saved locally.

**Conclusion for Q3: one probe script confirmed (`mcp-probe.mjs`); the second
one described in the task brief could not be located — reporting "unknown"
per instructions rather than guessing which file it might be.** The planning
session should treat the HTTP interface as already having a real test
(`http-interface.integration.test.ts`) to extend, not an ad-hoc script to
promote.

---

## Q4 — `packages/test-kit` inventory

Full export surface (`packages/test-kit/src/index.ts` + `node.ts`):

**`make*` factories** (pure builders, `Partial<T> = {}` → `T`, zero runtime
deps, usable ANYWHERE including e2e — they only import `@george43g/shared-types`
types):

```
packages/test-kit/src/factories/contract.ts:20   makeContractTab(over: Partial<Tab> = {}): Tab
packages/test-kit/src/factories/contract.ts:36   makeTabGroup(over: Partial<TabGroup> = {}): TabGroup
packages/test-kit/src/factories/contract.ts:47   makeContractWindow(over: Partial<BrowserWindow> = {}): BrowserWindow
packages/test-kit/src/factories/contract.ts:63   makeBrowserState(over: Partial<BrowserState> = {}): BrowserState
packages/test-kit/src/factories/contract.ts:77   makeSnapshot(over: Partial<Snapshot> = {}): Snapshot
packages/test-kit/src/factories/ext-wire.ts:16    makeExtTab(over: Partial<ExtTab> = {}): ExtTab
packages/test-kit/src/factories/ext-wire.ts:33    makeExtTabGroup(over: Partial<ExtTabGroup> = {}): ExtTabGroup
packages/test-kit/src/factories/ext-wire.ts:44    makeExtWindow(over: Partial<ExtWindow> = {}): ExtWindow
packages/test-kit/src/factories/ext-wire.ts:55    makeExtSnapshot(over: Partial<ExtSnapshot> = {}): ExtSnapshot
packages/test-kit/src/factories/chrome-api.ts:58  makeChromeTab(over: Partial<ChromeTabLike> = {})
packages/test-kit/src/factories/chrome-api.ts:73  makeChromeWindow(over: Partial<ChromeWindowLike> = {})
packages/test-kit/src/factories/chrome-api.ts:88  makeChromeTabGroup(over: Partial<ChromeTabGroupLike> = {})
```
Plus 4 HTML fixture strings for content-extraction tests (not e2e-relevant):
`ARTICLE_HTML`, `DIRTY_FORM_HTML`, `MEDIA_HTML`, `SPA_HTML`
(`packages/test-kit/src/fixtures/html.ts`).

**`install*`/`with*` lifecycle fakes:**

```
packages/test-kit/src/fakes/chrome.ts:107
installFakeChrome(config: FakeChromeConfig = {}): FakeChrome
  → { chrome: unknown; restore(); setWindows(); emit(); listener(); listenerCount(); storage: Map; calls: Record<string, unknown[][]> }
```
- **NOT usable from e2e / real-browser context.** It installs a fake
  `globalThis.chrome` shape inside the *Node process running the test*.
  Playwright e2e drives a REAL Chromium that already has a REAL
  `chrome.*` extension API (as `roundtrip.e2e.test.ts` does via
  `sw.evaluate(...)`) — there is no `globalThis` to monkeypatch from outside
  the browser process, and doing so wouldn't affect the extension running
  inside Chromium anyway. This is exclusively for node-side unit/integration
  tests of `extension-core`/daemon mapper code.

```
packages/test-kit/src/fakes/daemon-env.ts:25   makeTmpDir(prefix = "browser-tab-test-"): string
packages/test-kit/src/fakes/daemon-env.ts:40   randomWsPort(base = 18790, span = 500): number
packages/test-kit/src/fakes/daemon-env.ts:70   defaultIpcEndpoint(tmp: string): string
packages/test-kit/src/fakes/daemon-env.ts:76   withDaemonEnv(tmp: string, over: DaemonEnvOptions = {}): { restore(): void }
```
- `defaultIpcEndpoint` **is already used by e2e** (`fixtures.ts:81`, imported
  directly — confirmed above). `makeTmpDir`/`randomWsPort`/`withDaemonEnv`
  are NOT currently used by e2e; `fixtures.ts` hand-rolls its own env-setting
  logic (`startDaemon()`'s `shared`/`daemonEnv` objects) rather than calling
  `withDaemonEnv`, and hand-rolls its own port function (`ephemeralPort()`)
  rather than calling `randomWsPort`. These three ARE usable from e2e in
  principle (pure Node env/fs/math, no chrome dependency) — they're simply not
  wired in today. Note `randomWsPort`'s own doc comment
  (`daemon-env.ts:29-39`) warns it is "NOT collision-proof across files" and
  requires every vitest integration file to claim a disjoint `(base, span)` —
  the same caveat would apply if an e2e suite adopted it instead of
  `ephemeralPort()`.

```
packages/test-kit/src/fakes/websocket.ts:9   installNodeWebSocket(): { restore(): void }
```
- Bridges the `ws` npm package's `WebSocket` onto `globalThis.WebSocket` **so
  Node-side code can use a real WebSocket**. NOT needed/usable in e2e's
  browser context — Playwright's Chromium already has a native `WebSocket`.
  This exists specifically for `apps/browser-tab-mcp/tests/ext-socket.integration.test.ts`,
  where `extension-core`'s `DaemonSocket` runs *inside the Node test process*
  against a real daemon over loopback (no browser at all).

**Summary for Q4**: only the `make*` factories and the three `daemon-env.ts`
helpers (`makeTmpDir`, `randomWsPort`, `defaultIpcEndpoint`/`withDaemonEnv`)
are usable from an e2e context, because e2e's "code under test" runs inside a
real Chromium where a real `chrome.*` API and a real `WebSocket` already
exist — `installFakeChrome` and `installNodeWebSocket` exist specifically to
*substitute* for those two things in a plain Node test process, which is
precisely what e2e does NOT have (and does not want — the whole point of e2e
per the file headers is exercising the REAL implementations).

---

## Q5 — The single most likely way a large command-sweep suite breaks

**Order-dependent cascading failure from a shared, un-reset browser/daemon
context across many packed-in tests, not a resource/port problem.**

The evidence for the *shape* an agent would likely copy: `roundtrip.e2e.test.ts`
already establishes the pattern a "command sweep" would naturally extend —
`test.describe.configure({ mode: "serial" })` (roundtrip.e2e.test.ts:26) with
ONE `beforeAll` that pays the (expensive, ~2 minutes per the CI evidence below)
cost of `startDaemon()` + `launchExtension()` + the poll-for-`dataSource ===
"extension"` wait once, then multiple `test()`s inside that same `describe`
share the one daemon and one browser context, each test's assertions
implicitly depending on state left behind by the previous test (test 2 reads
`tallPage`/`ids` state created inline; nothing resets windows/tabs between
tests). `fixtures.ts` provides **zero** primitive for resetting state between
individual `test()`s within a describe block — its only cleanup surfaces are
file-level `beforeAll`/`afterAll` (`startDaemon`/`stop`,
`launchExtension`/`context.close()`). There is no `resetState()`,
`freshWindow()`, or per-test daemon.

Why this specific pattern is the likely failure mode for a *large* sweep
specifically: the cost evidence already on record —
`docs/agent-handoff/PROGRESS-LOG.md:1841`: `"e2e-branded matrix rows each
install+build (Windows builds 3×/PR)"` and the timing note
`"msedge-windows 1m57s, chromium-windows 2m43s"` for the CURRENT 3-test suite
— shows that spinning up a fresh daemon + fresh headless Chromium per test (or
per command) is expensive enough that an agent under CI-time pressure will be
strongly pulled toward packing many command assertions into ONE shared
`describe`/`beforeAll`, exactly as the existing file already does for its 2
tests. Scaled to "every command" (mute, pin, discard, reload, navigate,
duplicate, group create/add/remove/update, window open/set/close, focus,
screenshot, history, …), that means one bad/flaky command (e.g. the **already
open and unresolved** `act back`/`forward` no-op bug —
`docs/agent-handoff/PROGRESS-LOG.md`'s Open section: `"act back/forward: no-op
on BOTH real browsers... UNVERIFIED"`) leaves the shared browser/daemon in an
unexpected state and cascades failures into every subsequent, otherwise
-passing command test in the same file — turning a single real bug into a
wall of red that obscures which command actually failed, which defeats the
entire diagnostic purpose of a "command sweep" (isolating per-command pass/
fail signal). This is not hypothetical extrapolation from nothing: it is the
literal existing structure of `roundtrip.e2e.test.ts`, which the task's own
brief (PROGRESS-LOG.md:1896, "dual-truth assertions... transport tests from
the probe scripts") indicates the new suite is meant to extend rather than
replace.

The port-band mechanism (Q1) is a secondary, more containable risk: it is
currently self-consistent (single pid, `workers:1`) and only breaks if the
plan ALSO decides to parallelize workers or run concurrent daemons within one
file — a decision the plan controls directly, unlike the shared-state
pattern, which is baked into the one example file every new spec will be
written by analogy to.
