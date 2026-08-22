# R2 — Playwright real-browser feasibility experiments

Environment: macOS 15.7.7 arm64 (Darwin 24.6.0), Node v24.15.0, Playwright
`@playwright/test` 1.61.1, Playwright-bundled Chromium build 1228 ("Google
Chrome for Testing"), channel `chromium` (matches CI's `E2E_BROWSER_CHANNEL`
default). Repo: `/Users/george/repos/browser-tab-mcp`. Built artifacts used
as-is (no repo files modified): `apps/chrome-extension/dist/`,
`apps/browser-tab-mcp/dist/cli.js`.

All experiment scripts live in
`/private/tmp/claude-501/-Users-george-repos-browser-tab-mcp/5a15fe80-7e42-4cab-bc7a-eebf6ebf13bb/scratchpad/research/exp/`
(`e1-*.mjs`, `e2-*.mjs`, `e3-*.mjs`, `e4-*.mjs`, plus raw `*.log` outputs).
No file inside the git repo was created, edited, or deleted. No experiment
touched the user's real daemon, real socket path, or real browser profile —
every persistent context used a fresh `mkdtempSync` profile dir, and every
throwaway daemon used its own `BROWSER_TAB_STATE_DIR`/`_CACHE_DIR`/
`BROWSER_TAB_SOCKET_PATH`/`BROWSER_TAB_WS_PORT` (never `~/.browser-tab`).

Baseline (existing 3-test suite) run first, unmodified, to confirm the
starting point works:

```
$ pnpm --filter @george43g/chrome-extension test:e2e
Running 3 tests using 1 worker
  ✓ 1 e2e/load.e2e.test.ts:10:1 › loads the built extension and renders its options page (1.5s)
  ✓ 2 e2e/roundtrip.e2e.test.ts:68:3 › ... the daemon serves the real extension's tabs with x-handles (135ms)
  ✓ 3 e2e/roundtrip.e2e.test.ts:85:3 › ... a daemon-driven cross-window move preserves scroll (457ms)
  3 passed (4.3s)
```

---

## E1 — Reach into the MV3 service worker and call `chrome.*` directly

**VERDICT: WORKS**

`context.serviceWorkers()` (or `context.waitForEvent("serviceworker")` on
first launch, exactly as `fixtures.ts`'s `launchExtension()` already does)
returns a Playwright `Worker` whose `.evaluate()` runs inside the extension's
background/service-worker global scope, with full `chrome.*` access. This is
the SAME worker handle the existing `roundtrip.e2e.test.ts` already uses to
drive `chrome.windows.create` — this experiment goes further and reads
`chrome.tabs`/`chrome.windows`/`chrome.runtime` state back out.

Exact code that worked (`exp/e1b-sw-timing.mjs`, condensed):

```js
import { chromium } from "@playwright/test";

const context = await chromium.launchPersistentContext(userDataDir, {
  channel: "chromium",
  args: [
    `--disable-extensions-except=${DIST}`,
    `--load-extension=${DIST}`,
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
  ],
});

let [sw] = context.serviceWorkers();
if (!sw) sw = await context.waitForEvent("serviceworker", { timeout: 15000 });

const tabs = await sw.evaluate(() => chrome.tabs.query({}));
// => [{ id, url, title, windowId, active, discarded, status, ... }, ...]

const one = await sw.evaluate((id) => chrome.tabs.get(id), tabs[0].id);
const windows = await sw.evaluate(() => chrome.windows.getAll({ populate: false }));
const manifest = await sw.evaluate(() => chrome.runtime.getManifest());
```

Real captured output (`exp/e1-output.log`):

```
SW URL: chrome-extension://mngififidbjiclpgadnlkblgfikklcla/background.js
chrome.tabs.query({}) count: 3
tabs sample: [
  {"id":1371504133,"url":"about:blank","title":"about:blank","windowId":1371504132},
  {"id":1371504134,"url":"data:text/html,<title>Tab1</title><body>one</body>","title":"Tab1","windowId":1371504132},
  {"id":1371504135,"url":"data:text/html,<title>Tab2</title><body>two</body>","title":"Tab2","windowId":1371504132}
]
chrome.tabs.get(1371504134) => {"id":1371504134,"url":"data:...","active":false,"windowId":1371504132}
chrome.windows.getAll count: 1
manifest name/version: browser-tab connector 1.4.0
```

**Timing / gotchas:**
- Getting the worker reference (`waitForEvent`/first-tick `serviceWorkers()[0]`)
  took **54ms** in a clean run.
- `sw.evaluate()` round-trip cost: first call **114–165ms**, subsequent calls
  **1–4ms** (`exp/e1b-output.log`). This is CDP round-trip overhead, not a
  real slowdown, and it's the same channel `fixtures.ts` already pays for the
  extension move test.
- **One outlier, not reproduced**: the very first experiment run
  (`exp/e1-output.log`) measured `chrome.tabs.query({})` at **10,447ms**. A
  follow-up run with identical code and finer-grained timing
  (`exp/e1c-output.log`) attributed essentially all of the elapsed time to
  `context.newPage()` + `page.goto()` calls (30ms/16ms/24ms/15ms), with the
  `sw.evaluate()` call itself at 114ms — i.e. the 10s was very likely
  transient host contention (other tooling running concurrently on this
  machine), not an inherent property of the SW bridge. Flagging as inferred,
  not confirmed — a suite relying on tight per-call timeouts should still
  budget headroom.
- **Worker eviction**: MV3 service workers can idle-evict after ~30s with no
  events. Tested by holding a `Worker` handle idle for 40s
  (`exp/e1d-sw-eviction.mjs`) then reusing it — no eviction observed;
  `context.serviceWorkers()` still listed the same worker URL and the SAME
  stale `Worker` object handle answered `chrome.tabs.query({})` in 9ms
  (`exp/e1d-output.log`). This is a soft signal, not exhaustive — Chromium's
  real eviction heuristics depend on pending events/alarms/connections that a
  bare, daemon-disconnected extension instance may not trigger the same way
  a fully wired one would over a long CI run.

---

## E2 — Real gestured history via Playwright `page.click()`, honoured by `goBack`

**VERDICT: WORKS**

Recipe (`exp/e2-gesture-back.mjs`, the decisive part): serve two real HTTP
pages locally (avoids Chromium's "block top-frame navigation to `data:`
URLs" policy contaminating the result), navigate to page A, `page.click()` a
real `<a href>` link to page B (this IS a trusted user gesture in Chromium's
navigation-transition model), then drive `chrome.tabs.goBack(tabId)` from the
extension's service worker — exactly the code path `commands.ts:135` uses in
production (`await tabs.goBack(tabId)`).

```js
const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "text/html");
  if (req.url === "/a.html") res.end('<a id="link" href="/b.html">go to B</a>');
  else if (req.url === "/b.html") res.end("<h1>Page B</h1>");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const page = await context.newPage();
await page.goto(`${base}/a.html`);
await page.click("#link");                       // <-- real trusted gesture
await page.waitForURL(`${base}/b.html`);

const [{ id: tabId }] = await sw.evaluate(() =>
  chrome.tabs.query({ active: true, lastFocusedWindow: true }),
);

await sw.evaluate((id) => chrome.tabs.goBack(id), tabId);
await page.waitForTimeout(500);
// page.url() === `${base}/a.html`  -> gesture-marked history WAS honoured
```

Real output, both headed and `--headless=new` (`exp/e2-output.log`,
`exp/e2b-output-headless.log` — byte-identical results):

```
[Scenario 1] gesture-click navigation
  before click, url = http://127.0.0.1:PORT/a.html
  after click, url = http://127.0.0.1:PORT/b.html
  after chrome.tabs.goBack(), url = http://127.0.0.1:PORT/a.html
  RESULT scenario1: WENT BACK (honoured)

[Scenario 2] extension-driven chrome.tabs.update (no gesture) — CONTROL
  before update, url = http://127.0.0.1:PORT/a.html
  after update, url = http://127.0.0.1:PORT/c.html
  after chrome.tabs.goBack(), url = about:blank
  RESULT scenario2: DID NOT GO BACK (skipped)
```

This directly confirms the background fact stated in the task brief: a
script-initiated `chrome.tabs.update({url})` navigation is skippable and
`goBack()` does not return to the prior page (control here actually landed on
`about:blank`, i.e. even worse than a no-op — it fell off the front of a
1-entry history, not back to `/a.html`); a Playwright `page.click()` on a real
`<a>` produces a gesture Chromium's `NavigationController` marks as
skip-eligible=false, and `chrome.tabs.goBack()` honours it correctly.

**Gotchas:**
- Must use **real HTTP** (or presumably `file://`) pages, not `data:` URLs —
  Chromium blocks top-frame navigation TO `data:` URLs from a link click
  regardless of gesture (untested directly here but consistent with known
  Chromium policy since M82; sidestepped by spinning a throwaway
  `http.createServer` in the test process, ephemeral port, closed in
  `finally`). This is the one part of the recipe that is **inferred**
  reasoning about why `data:` links would fail, not something this
  experiment observed failing — the working recipe above was written
  HTTP-first from the start.
- Must resolve the tab id via the SAME identity the click happened in
  (`chrome.tabs.query({active:true, lastFocusedWindow:true})` right after the
  click) — using a stale id from before navigation is a foot-gun in a
  multi-tab suite.
- No special waits were needed beyond `page.waitForURL()` after the click and
  a flat `page.waitForTimeout(500)` after `goBack()` before reading
  `page.url()` — `goBack()`'s underlying navigation is not synchronously
  observable through the extension API, so any real suite needs a poll/settle
  window here (500ms was sufficient in both headed and headless runs; not
  stress-tested for flakiness margin).

---

## E3 — Does `discard` change the tab's id, observably?

**VERDICT: COULD NOT ESTABLISH** — `chrome.tabs.discard()` crashes the
browser process outright in this environment, both headless and headed,
reproducibly across 3 attempts. Before/after ids were never observed because
there is no "after": the browser is gone.

Exact code that triggered it (`exp/e3c-discard-diag.mjs`, relevant part):

```js
const before = await sw.evaluate(() => chrome.tabs.query({}));
const targetId = before.find((t) => t.url?.includes("example.com"))?.id;

const discardResult = await sw.evaluate((id) => chrome.tabs.discard(id), targetId);
// <-- browser process SEGVs here, every time
```

Exact error, verbatim (`exp/e3-output.log`, `exp/e3-output-run2.log`,
`exp/e3c-headless.log`, `exp/e3c-headed.log` — all four runs identical in
kind):

```
worker.evaluate: Target page, context or browser has been closed
Browser logs:
<launching> .../Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing ... --headless=new ...
<launched> pid=NNNNN
[pid=NNNNN][err] Received signal 11 SEGV_ACCERR 000000000000
[pid=NNNNN][err]  [0x0001177f3c5c]
... (30+ line native stack trace, no symbols) ...
[pid=NNNNN][err] [PID:TID:DATE/TIME:ERROR:gpu/command_buffer/service/shared_image/shared_image_manager.cc:361] SharedImageManager::ProduceOverlay: Trying to Produce a Overlay representation from a non-existent mailbox.
[pid=NNNNN][err] [PID:TID:DATE/TIME:ERROR:components/viz/service/display_embedder/skia_output_device_buffer_queue.cc:258] Invalid mailbox.
```

**Attempts made (time-boxed at 3, per instructions):**
1. `--headless=new`, no-sandbox, default Playwright chromium — crash.
2. Same, re-run for reproducibility — crash, identical SEGV signature.
3. `headless: false` (real windowed Chromium) — **also crashes**, same
   SEGV_ACCERR signature, ruling out "headless-only" as the cause.

**What this rules in/out:** this is not a timing/flake issue (100%
reproducible, 3/3) and not specific to `--headless=new` (headed crashes too).
It looks like a GPU/shared-image compositor bug triggered specifically when a
tab with an active renderer (navigated to a real page,
`waitForLoadState("load")` completed) is discarded — the crash log's
`SharedImageManager`/`skia_output_device_buffer_queue` errors point at
compositor resource teardown during discard, likely interacting with
`--enable-unsafe-swiftshader` (software GL, present in every launch's arg
list per the captured `<launching>` line) or `--disable-dev-shm-usage`. Did
not chase further per the time-box. **This is a genuine, observed blocker for
this specific technique** — not a "component doesn't exist" gap but "the
action itself crashes the driving browser instance" — worth flagging loudly
to the planning session since it means `discard` cannot be exercised through
Playwright's bundled Chromium build 1228 on this host at all, success or
failure; the whole browser process dies with it. Untested: whether a
system-installed Chrome/Chromium (not Playwright's bundled build), a newer
Playwright chromium revision, or `chrome`/`msedge` channels avoid this — none
of those were tried, all inferred as open questions.

---

## E4 — Cost model

**VERDICT: WORKS** (numbers below are all directly measured, 3+ trials each)

**Full existing 3-test suite, unmodified, via the real npm script:**

| Run | Playwright-reported | Wall (incl. pnpm/node startup) |
|---|---|---|
| 1 | 3 passed (4.3s) | 4.854s total |
| 2 | 3 passed (3.8s) | 4.362s total |

**Per-fixture overhead, 3 independent trials** (`exp/e4-cost-model.mjs`,
`exp/e4-output.log`), reimplementing `startDaemon()`/`launchExtension()`
exactly as `fixtures.ts` does (throwaway state/cache dirs, throwaway unix
socket, fake AppleScript adapter for the daemon side, `--headless=new`
Chromium loading the same built `dist/`):

```
trial 1: startDaemon() 279ms (1 status poll) | launchExtension() 961ms | context.close() 75ms | daemon.stop() 302ms
trial 2: startDaemon() 546ms (2 status polls) | launchExtension() 397ms | context.close() 64ms  | daemon.stop() 302ms
trial 3: startDaemon() 553ms (2 status polls) | launchExtension() 399ms | context.close() 66ms  | daemon.stop() 303ms
```

Summary: **startDaemon() ≈ 280–550ms**, **launchExtension() ≈ 400–960ms**
(first trial's 961ms includes a JIT/cache-cold Chromium relaunch; steady
state is ~400ms), teardown (`context.close()` + `daemon.stop()`) ≈ 350–380ms
combined. **Total fixture round-trip per file ≈ 1.0–1.9s**, dwarfing actual
test-body time (the two roundtrip assertions ran in 135ms and 457ms against
an already-warm fixture).

**Are fixtures per-test or per-file today?** Read directly from the existing
test files: `load.e2e.test.ts` calls `launchExtension()` inline in its one
test (no sharing needed, only one test). `roundtrip.e2e.test.ts` uses
`test.describe.configure({ mode: "serial" })` + a single `test.beforeAll()`
that calls `startDaemon()` once and `launchExtension()` once, shared across
its 2 tests, torn down once in `test.afterAll()`. So **today: 1 daemon start
+ 2 extension launches total, for 3 tests** — already file-scoped/shared
sharing, not per-test.

**Projection for ~8 files with a fresh daemon+extension fixture per file**
(not shared across files, consistent with today's per-file pattern): 8 ×
(≈550ms daemon + ≈400ms extension + ≈380ms teardown) ≈ **8 × 1.3s ≈ 10.5s**
of pure fixture overhead, serial (the existing config is
`fullyParallel: false, workers: 1`). Add real per-test assertion time
(hundreds of ms each based on the roundtrip tests) and this stays in the
**15–25s range total for 8 files with 1–3 tests each** — affordable, no
sharing required. Sharing a single daemon+extension context across ALL 8
files would save perhaps 8–9s of the ~10.5s fixture overhead, i.e. roughly a
2x speedup on setup cost, at the expense of losing per-file isolation (a
crash — see E3 — in one file would kill fixtures for every subsequent file
sharing that context). Given E3's crash finding, **shared-context risk is
concrete, not hypothetical**: any file that ever calls `chrome.tabs.discard`
would need its OWN isolated context regardless of the general sharing
decision, or the crash takes down every other file's fixtures riding the
same browser process.

---

## Summary of verdicts

| Experiment | Verdict |
|---|---|
| E1 — SW access to `chrome.*` | **WORKS** |
| E2 — gestured history + `goBack` | **WORKS** |
| E3 — `discard` id-change observation | **COULD NOT ESTABLISH** (browser crashes, SEGV, 3/3 reproducible, headed+headless) |
| E4 — cost model | **WORKS** — measured, see numbers above |
