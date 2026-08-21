# Edge as a first-class browser — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `"edge"` to the browser enum everywhere the set is spelled, so Microsoft Edge is detected, addressed (`t:edge:x…`), extension-paired, history-queried, and documented — instead of today's pin-to-chromium workaround that mislabels it.

**Architecture:** One additive enum member rippled through EVERY hardcoded copy of the browser set. The exploration (2026-08-21) found the copies; two brief claims were corrected: there is NO Rust browser enum to mirror (`types.rs` holds only structs; the drift test regexes `pub struct` only — zero work), and `makeAdapter`/`applescriptCaps` are derived (`!== "safari"` dispatch / derived caps fn — zero edits). Contract note: additive enum member, Snapshot stays `version: 2`, no bump.

**Tech Stack:** Zod enum in shared-types, TS across app + extension-core, `.usage.kdl` + `pnpm artifacts` (mise-pinned usage 3.3.0) for CLI artifacts.

**Spec:** `docs/agent-handoff/BACKLOG.md` § BRIEF item 3 (with the two corrections above — note them when closing the BACKLOG item).

## Global Constraints

- Rebuild with `pnpm build`, never bare `turbo run build`.
- `src/**` changes → README must change in the same PR (readme-check gate), and this plan has a real README delta anyway.
- NEVER hand-edit `completions/`, `man/`, `docs/cli/` — edit `.usage.kdl` then `pnpm artifacts` (from `apps/browser-tab-mcp/`); CI's `check:usage` byte-compares.
- Adding `"edge"` to `BrowserIdSchema` makes TWO things fail until their edits land in the same commit: `engine.test.ts:21` (DEFAULT_BROWSERS ≡ schema tripwire) and `fake.ts:26` (`Record<BrowserId, string>` — hard typecheck error). Task 1 is therefore an atomic set.
- macOS Edge spec values: `bundleId: "com.microsoft.edgemac"` (from the BACKLOG). `appName`/`processName: "Microsoft Edge"` are the expected values but are NOT verified in this repo — verify on a machine with Edge installed before trusting the AppleScript path (Step noted in Task 5; the extension path doesn't use them).
- Every new guard test gets a sabotage check (break → red → restore → verify file state after restore).

---

### Task 1: The atomic enum set (schema + engine + ids + fake + specs)

**Files:**
- Modify: `packages/shared-types/src/base.ts:11`
- Modify: `apps/browser-tab-mcp/src/detect/engine.ts:9-10` (comment), `:34` (DEFAULT_BROWSERS)
- Modify: `apps/browser-tab-mcp/src/detect/ids.ts:24` AND `:98` (two independent copies in one file)
- Modify: `apps/browser-tab-mcp/src/detect/adapters/chromium.ts:49-68` (CHROMIUM_SPECS)
- Modify: `apps/browser-tab-mcp/src/detect/adapters/fake.ts:26-32` (FAKE_BUNDLES Record)
- Test: `apps/browser-tab-mcp/tests/adapters.test.ts` (edge handle round-trip)

**Interfaces:**
- Produces: `BrowserId` now includes `"edge"`; `specFor("edge")` returns `{browser:"edge", appName:"Microsoft Edge", bundleId:"com.microsoft.edgemac", processName:"Microsoft Edge"}`; handle grammar accepts `t:edge:x123` / `w:edge:…` / `g:edge:x…`. Every later task consumes this.

- [ ] **Step 1: Write the failing round-trip test**

In `tests/adapters.test.ts`, next to the existing `makeWindowId("brave", 42)` round-trips (:100,115-116):

```ts
it("edge handles round-trip through the id grammar", () => {
  expect(parseTabId(makeExtTabId("edge", 123))).toEqual({ browser: "edge", gen: "ext", id: 123 });
  expect(parseWindowId(makeWindowId("edge", 42))).toMatchObject({ browser: "edge" });
  expect(parseGroupId(makeGroupId("edge", 7))).toMatchObject({ browser: "edge" });
});
```

(Match the exact helper names/shapes used by the neighboring brave cases — copy their assertion style.)

- [ ] **Step 2: Run to verify it fails** — `parseTabId` returns `null` for `t:edge:x123` (typecheck may already refuse `"edge"`; that's the same failure, earlier).

- [ ] **Step 3: The atomic production edit**

1. `base.ts:11`: `.enum(["chrome", "chromium", "brave", "edge", "safari"])`
2. `engine.ts:34`: `DEFAULT_BROWSERS = ["chrome", "chromium", "brave", "edge", "safari"]` — the tripwire test `engine.test.ts:21-25` asserts this list ≡ `BrowserIdSchema.options`.
3. `engine.ts:9-10` header comment: fix the set AND the stale default (it currently claims `"chrome,brave,safari"`, which was already wrong — the real default includes chromium).
4. `ids.ts:24`: add `"edge"` to the `BROWSERS` array. `ids.ts:98`: regex becomes `/^t:(chrome|chromium|brave|edge|safari):(x?)(\d+)$/`. BOTH copies — they serve different parsers.
5. `chromium.ts` CHROMIUM_SPECS — append:

```ts
  {
    browser: "edge",
    appName: "Microsoft Edge",
    bundleId: "com.microsoft.edgemac",
    processName: "Microsoft Edge",
  },
```

Membership in `CHROMIUM_SPECS` alone routes Edge to the Chromium AppleScript adapter (`makeAdapter` dispatch is `!== "safari"` — no edit) and into `enabledBrowsers()` validity (derived from ALL_SPECS — no edit). `applescriptCaps` is derived — no edit; Edge gets `backForward: true` for free.
6. `fake.ts:26-32`: add `edge: "com.microsoft.edgemac"` to `FAKE_BUNDLES` (the exhaustive Record makes typecheck the enforcement).

- [ ] **Step 4: Run the gates**

Run: `pnpm typecheck && pnpm --filter browser-tab-mcp test`
Expected: PASS — including `engine.test.ts` ("defaults to EVERY browser the schema knows" goes green again) and the new round-trip.

- [ ] **Step 5: Commit**

```bash
git add packages/shared-types/src/base.ts apps/browser-tab-mcp/src/detect/engine.ts apps/browser-tab-mcp/src/detect/ids.ts apps/browser-tab-mcp/src/detect/adapters/chromium.ts apps/browser-tab-mcp/src/detect/adapters/fake.ts apps/browser-tab-mcp/tests/adapters.test.ts
git commit -m "feat(detect): edge joins the browser enum — schema, ids grammar, specs, defaults"
```

---

### Task 2: Extension self-detection (`edg/` BEFORE the chrome fallback)

**Files:**
- Modify: `packages/extension-core/src/runtime.ts:26` (BrowserName union), `:29-37` (detectBrowserName)
- Test: `packages/extension-core/src/runtime.test.ts:33-47`

**Blast radius (why this is its own task):** an Edge extension self-reporting `"chrome"` registers under the chrome session key in the daemon (`ws-server.ts` keeps one session per BrowserId, reconnect evicts) — so a real Chrome connector and the Edge connector would knock each other offline, and Edge tabs would carry `t:chrome:x…` handles. This is the highest-consequence miss on the list.

- [ ] **Step 1: Write the failing test**

```ts
it("returns edge for an Edge UA (edg/ outranks the chrome fallback)", () => {
  fakeNavigator(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.2592.87",
  );
  expect(detectBrowserName()).toBe("edge");
});
```

(Use the same navigator-faking helper the three existing cases at :33-47 use.)

- [ ] **Step 2: Run to verify it fails** — returns `"chrome"`.

- [ ] **Step 3: Fix**

`runtime.ts:26`: `export type BrowserName = "chrome" | "chromium" | "brave" | "edge" | "safari";` — this union hand-duplicates `BrowserIdSchema` on purpose (extension-core bundles standalone); keep them in sync manually and say so in the adjacent comment.

In `detectBrowserName()`, the UA is lowercased at :30, and the safari branch already excludes Edge (Edge UA contains "chrome"). Insert after the safari branch, before `return "chrome"`:

```ts
  // Edge UA carries BOTH "Chrome/…" and "Edg/…" — check edg/ before the
  // chrome fallback or Edge self-reports as chrome and evicts the real
  // Chrome session in the daemon (one WS session per BrowserId).
  if (ua.includes("edg/")) return "edge";
```

- [ ] **Step 4: Run** `pnpm --filter @george43g/extension-core test` — PASS, all four UA cases.

- [ ] **Step 5: Sabotage check** — move the `edg/` check AFTER `return "chrome"` is unreachable, so instead: temporarily change it to `ua.includes("edge/")` (wrong token) → test red → restore → `git diff packages/extension-core/src/runtime.ts` shows only the intended change.

- [ ] **Step 6: Commit**

```bash
git add packages/extension-core/src/runtime.ts packages/extension-core/src/runtime.test.ts
git commit -m "feat(ext): detect Edge from the UA before the chrome fallback"
```

---

### Task 3: Options dropdown + history CHROME_FAMILY

**Files:**
- Modify: `apps/chrome-extension/public/options.html:56-63`
- Modify: `apps/browser-tab-mcp/src/daemon/history.ts:27`
- Test: `apps/browser-tab-mcp/src/daemon/history.test.ts` (extend the source-list assertions at :110-112,141-142)

- [ ] **Step 1: Dropdown** — add `<option value="edge">Edge</option>` between Chromium and Safari in `options.html`. No TS edit (`options.ts` just casts `select.value`). Without this, `browserSelect.value = "edge"` on load silently resolves to `""` and wipes the user's pin. The Safari wrapper has no options.html of its own — one file.

- [ ] **Step 2: Write the failing history test** — extend the existing CHROME_FAMILY assertions so the merged-query source list must include an `edge` entry (copy the `brave`/`chromium` assertion shape at history.test.ts:110-112).

- [ ] **Step 3: Run to verify it fails**, then add `"edge"` to `CHROME_FAMILY` (`history.ts:27`). Edge is Chromium — `chrome.history` works over the extension identically. Without this, a merged `history` call silently never asks Edge — exactly the "was Safari asked or empty?" ambiguity `sources` reporting was built to kill.

- [ ] **Step 4: Run** `pnpm --filter browser-tab-mcp exec vitest run src/daemon/history.test.ts` — PASS.

- [ ] **Step 5: Rebuild the extension bundle and eyeball the dropdown**: `pnpm --filter @george43g/chrome-extension build` then open `apps/chrome-extension/dist/options.html` — Edge option present. (The build-output guard tests must stay green: `pnpm --filter @george43g/chrome-extension test`.)

- [ ] **Step 6: Commit**

```bash
git add apps/chrome-extension/public/options.html apps/browser-tab-mcp/src/daemon/history.ts apps/browser-tab-mcp/src/daemon/history.test.ts
git commit -m "feat(edge): options-page choice + history chrome-family membership"
```

---

### Task 4: CLI strings, `.usage.kdl`, artifacts regen, `.env.example`, url-policy pin

**Files:**
- Modify: `apps/browser-tab-mcp/src/cli.ts:363,548,577,640,681` (five `--browser` help strings)
- Modify: `apps/browser-tab-mcp/src/tools/open-tab.ts:20`, `apps/browser-tab-mcp/src/tools/list-tabs.ts:161` (tool description strings)
- Modify: `apps/browser-tab-mcp/.usage.kdl:96,115,194,231,252` (+ the `list`/`history` help lines at :95,140)
- Modify: `apps/browser-tab-mcp/.env.example:67-69`
- Test: `apps/browser-tab-mcp/src/tools/url-policy.test.ts` (add an `edge://settings` accept case — the scheme is ALREADY allowlisted at `url-policy.ts:47`; this just pins it)
- Regenerate: `completions/`, `man/`, `docs/cli/` via `pnpm artifacts` — never by hand

- [ ] **Step 1: Edit the strings** — every `chrome|chromium|brave|safari` becomes `chrome|chromium|brave|edge|safari`; the `group` variants (`cli.ts:640`, `.usage.kdl:231`) become `chrome|chromium|brave|edge` (groups are Chromium-family; Safari stays out). The `reload-extension` choices block (`.usage.kdl:115`) gains `"edge"`.

- [ ] **Step 2: Fix `.env.example:68-69`** — the comment list gains edge, and the literal default becomes the REAL default: `BROWSER_TAB_BROWSERS=chrome,chromium,brave,edge,safari` (the current line omits chromium — already a lie; a copied `.env` with the stale line silently excludes Edge forever and looks like a detection bug).

- [ ] **Step 3: url-policy pin**

```ts
it("accepts edge:// (browser-internal scheme, already allowlisted)", () => {
  expect(() => assertUrlAllowed("edge://settings")).not.toThrow();
});
```

(Copy the exact call shape from the `brave://settings` case at url-policy.test.ts:60.)

- [ ] **Step 4: Regenerate artifacts**

Run: `cd apps/browser-tab-mcp && pnpm artifacts && pnpm check:usage`
Expected: regen touches `completions/browser-tab.{bash,fish}`, `completions/_browser-tab`, `man/browser-tab.1`, `docs/cli/{list,open,group,reload-extension,window/open}.md`; `check:usage` then passes (byte-identical). If `check:usage` fails, the regen and the kdl edit disagree — fix the kdl, regen again; NEVER touch the generated files.

- [ ] **Step 5: Run** `pnpm --filter browser-tab-mcp test && pnpm lint` — PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/browser-tab-mcp/src/cli.ts apps/browser-tab-mcp/src/tools/open-tab.ts apps/browser-tab-mcp/src/tools/list-tabs.ts apps/browser-tab-mcp/.usage.kdl apps/browser-tab-mcp/.env.example apps/browser-tab-mcp/src/tools/url-policy.test.ts apps/browser-tab-mcp/completions apps/browser-tab-mcp/man apps/browser-tab-mcp/docs
git commit -m "feat(edge): CLI/help/usage surfaces + env example + edge:// pin"
```

---

### Task 5: Docs, verification sweep, PR

**Files:**
- Modify: `docs/WM_STACK_CONTRACT.md:27` (`// chrome | brave | chromium | edge | safari` + one line noting the addition is additive, v2 unchanged), `docs/HANDOFF.md:17,101`, `docs/agent-handoff/GOTCHAS.md:107`, `apps/browser-tab-mcp/README.md` (browser list mentions), `AGENTS.md` ("What This Repo Is" browser list)
- Modify: `docs/agent-handoff/BACKLOG.md` — close the Edge item (:721-736) with a dated note: shipped, and the brief's `types.rs`-mirror claim was wrong (no Rust browser enum exists; drift test parses structs only).

- [ ] **Step 1: Make the doc edits above.**

- [ ] **Step 2: Full gates**: `pnpm verify` (lint + typecheck + test + build). Then `pnpm stress` — the harness pins explicit browser lists so nothing changes, but Task 1 touched the detect engine defaults; cheap insurance.

- [ ] **Step 3: Live verification — two halves, both gated on George:**
  - **Windows box (extension path, the half that matters off-macOS):** ~90s in Edge on the box — load unpacked from `D:\browser-tab-mcp\dist`, options page → browser: **edge** (no more pin-to-chromium), paste token. Then `browser-tab list --json` must show `browser: "edge"` with `t:edge:x…` handles alongside the chrome session, both connected simultaneously (the eviction bug this plan's Task 2 prevents). George runs the Edge side; coordinate over the existing tmux session.
  - **macOS (AppleScript path):** only if Edge is installed on the Mac — `browser-tab doctor` shows edge Automation TCC row; `browser-tab list` sees an Edge window via osascript. If Edge isn't installed: `running:false` costs one probeProcess and is the designed behavior; note "AppleScript half verified only as not-crashing" honestly in the PR.

- [ ] **Step 4: Push branch `feat/edge-first-class`, open PR** titled `feat: Microsoft Edge as a first-class browser` — body lists the surfaces table from the exploration and names the two brief corrections. George's word gates the merge.
