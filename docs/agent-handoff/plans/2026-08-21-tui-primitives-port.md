# TUI primitives port + polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the TUI's hand-rolled width math, cursor logic, and viewport onto `@george43g/tui-kit@0.5.0`'s primitives (`fitToWidth`, `allocateWidths`, `navReduce`, `scrollbarThumb`), add the scrollbar and the sticky detail pane, and land four small polish fixes found in the 2026-08-21 feature drive.

**Architecture:** `App.tsx` (385-line monolith) sheds its row width math into a new pure module `src/tui/row-layout.ts` built on the kit primitives; cursor state moves onto `navReduce`'s `NavState`; the viewport gains a right-edge scrollbar and a width-allocated detail pane that drops when narrow. The stress harness's width measure is fixed FIRST because padding rows to exact width breaks its UTF-16 measure.

**Tech Stack:** ink 7 + react 19, `@george43g/tui-kit` ^0.5.0 (published npm, verified on registry 2026-08-21), ink-testing-library, vitest.

**Deliberately NOT adopted:** `lineWindow`. Our rows are homogeneous height-1, `visibleWindow` already covers that exactly and is pinned by `src/tui/viewport.test.ts`; `lineWindow(heightOf: () => 1)` would be an equivalent-output swap with churn and no gain. It becomes the right tool the day any list row grows variable height (e.g. wrapped detail lines inside the list) — note for then, not now.

**Spec:** `docs/agent-handoff/BACKLOG.md` § "2026-08-21 — BRIEF" item 5, plus the tui-kit 0.5.0 design negotiation (collapse rule: context collapses, elaboration drops — the detail pane is elaboration and DROPS).

## Global Constraints

- Rebuild with `pnpm build`, never bare `turbo run build` (BUILD_STAMP is part of the cache key).
- `src/**` changes require a README update or `[skip-readme]` in the PR title — this plan changes user-visible TUI behavior, so UPDATE the README (Task 10), don't skip.
- Tests: colocated `*.test.ts(x)` for unit; `vi.mock("./useSnapshot.js")` must come BEFORE a dynamic `await import("./App.js")` — a static import hoists above the mock and opens a real daemon socket in CI.
- Any test looping terminal geometries needs an explicit `SLOW_RENDER_MS = 30_000` timeout (cold Windows runners exceed vitest's 5s default — pattern at `App.width.test.tsx:157-167`).
- Every new guard test gets a sabotage check: break the guarded thing, watch the test go red, restore, VERIFY file state after restore (`git checkout <file>` on a branch restores the BRANCH version and wipes uncommitted fixes — re-check after every restore).
- Conventional-commit titles; one commit per task; commits signed (1Password gates signing — if a commit prompts, tell George).
- The chrome budget is a hard invariant: header 1 + StatusBar 2 + HelpBar 1 = kit `CHROME_ROWS = 4`, pinned by `src/tui/viewport.test.ts`. Nothing in this plan may add a chrome line.

---

### Task 1: Bump tui-kit to ^0.5.0

**Files:**
- Modify: `apps/browser-tab-mcp/package.json:69` (`"@george43g/tui-kit": "^0.4.1"` → `"^0.5.0"`)

**Interfaces:**
- Produces: the 0.5.0 exports later tasks import: `fitToWidth(str, cols, ellipsis?)` (postcondition `visualWidth(result) === cols` EXACT), `allocateWidths(total, cols: ColumnSpec[]) → {widths: Record<string,number>, collapsed: string[]}` (`ColumnSpec = {id, min, preferred, max?, priority, collapse?: "drop"|"breadcrumb"|"min", collapsedWidth?}`), `scrollbarThumb({start, end, total}, trackRows) → {thumbStart, thumbRows}`, `hiddenCounts`, `navReduce(state: NavState, intent: NavIntent, ctx: NavContext) → NavState` (`NavState = {cursor, count, touched}`, intents `up|down|pageUp|pageDown|top|bottom|digit|groupJump|set|itemsReplaced`), `applyRestore`, `lineWindow`, `chooseAnchor`. Everything currently imported (`viewportRows`, `visibleWindow`, `CHROME_ROWS`, `truncateToWidth`, `visualWidth`, `useVimKeys`, components) is still exported in 0.5.0.

- [ ] **Step 1: Edit the dep range**

In `apps/browser-tab-mcp/package.json` change the line to `"@george43g/tui-kit": "^0.5.0",`.

- [ ] **Step 2: Install and assert the resolved version**

Run: `pnpm install && pnpm --filter browser-tab-mcp exec node -e "console.log(require('@george43g/tui-kit/package.json').version)"`
Expected: `0.5.0` (this repo is pnpm 10.29.3, so pnpm 11's `minimumReleaseAge` quarantine does not apply — but assert anyway; a stale resolution here invalidates every later task).

- [ ] **Step 3: Clean up the dead workspace residue**

`packages/tui-kit/` contains only `dist/`, `node_modules/`, `.turbo/` — no `package.json`, nothing resolves to it. Run `git status --porcelain packages/tui-kit/` — expect NO tracked entries. If untracked-only: `node scripts/rimraf.mjs packages/tui-kit` (repo rule: no bare `rm -rf`, cmd.exe compat). If anything IS tracked, stop and report instead of deleting.

- [ ] **Step 4: Baseline gates**

Run: `pnpm typecheck && pnpm test`
Expected: green — 0.5.0 is additive over 0.4.1 for every symbol in use. `src/tui/viewport.test.ts` still passes (CHROME_ROWS unchanged in 0.5.0).

- [ ] **Step 5: Commit**

```bash
git add apps/browser-tab-mcp/package.json pnpm-lock.yaml
git commit -m "chore(tui): bump tui-kit to 0.5.0 (fitToWidth/allocateWidths/navReduce/scrollbarThumb)"
```

---

### Task 2: Polish — `list --fields summary` header counts tabCount, not rows

**Files:**
- Modify: `apps/browser-tab-mcp/src/render.ts:168-176` (WindowLike), `apps/browser-tab-mcp/src/render.ts:267` (the count)
- Test: `apps/browser-tab-mcp/src/render.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks (independent — can run first or last).
- Produces: `WindowLike` gains `tabCount?: number`.

- [ ] **Step 1: Verify the filter interplay first (read, don't assume)**

Read `apps/browser-tab-mcp/src/tools/list-tabs.ts:134+` (`applyFilters`). Question: when a `--url`/title filter drops tab rows, does it rewrite `tabCount`? The precedence below assumes it does NOT (rows are the honest count when rows exist). If it DOES rewrite, use `w.tabCount ?? w.tabs?.length ?? 0` instead and note it in the commit message.

- [ ] **Step 2: Write the failing test**

In `render.test.ts`, next to the existing header pin at `:130` (`expect(out).toContain("extension · 1 window · 2 tabs")` — must stay green):

```ts
it("summary projection counts tabCount, not the emptied rows", () => {
  const snap = summarySnapshot(); // clone the :100-124 fixture; per window: tabs: [], tabCount: 2
  const out = stripAnsi(renderSnapshot(snap, 120));
  expect(out).toContain("1 window · 2 tabs");
  expect(out).not.toContain("0 tabs");
});
```

Build `summarySnapshot()` by copying the existing fixture and setting `tabs: []`, `tabCount: 2` on the window (the shape `list-tabs.ts:109-120` actually emits for `fields:"summary"`).

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter browser-tab-mcp exec vitest run src/render.test.ts`
Expected: FAIL — header says `0 tabs`.

- [ ] **Step 4: Fix**

Widen `WindowLike` (render.ts:168-176) with `tabCount?: number;`. Change render.ts:267 to:

```ts
const tabCount = windows.reduce(
  (n, w) => n + (w.tabs?.length ? w.tabs.length : (w.tabCount ?? 0)),
  0,
);
```

Rows win when rows exist (matches what's printed beneath, including post-filter); `tabCount` fills in when the projection emptied them.

- [ ] **Step 5: Run tests to verify both pins pass**

Run: `pnpm --filter browser-tab-mcp exec vitest run src/render.test.ts`
Expected: PASS including the existing `:130` pin (its fixture has rows, no tabCount — unchanged path).

- [ ] **Step 6: Commit**

```bash
git add apps/browser-tab-mcp/src/render.ts apps/browser-tab-mcp/src/render.test.ts
git commit -m "fix(cli): summary header counts tabCount instead of the projection-emptied rows"
```

---

### Task 3: Polish — half-page motions clear the message, respect modal modes, clamp like everyone else

**Files:**
- Modify: `apps/browser-tab-mcp/src/tui/App.tsx:101-128`
- Test: create `apps/browser-tab-mcp/src/tui/App.halfpage.test.tsx`

The three defects in one handler pair (`App.tsx:125-126`): `^d`/`^u` don't clear `message` (the `onMove` comment at 108-110 over-claims "Any motion retires…"), don't have the `mode.kind` branch (so they move the hidden browse cursor while the user steers a modal list), and `onHalfPageUp` clamps differently from the other three motion handlers.

- [ ] **Step 1: Write the failing test**

Copy the `App.move.test.tsx` skeleton (vi.mock useSnapshot → dynamic imports → render in ThemeProvider → `stdin.write` + `tick()`; `vi.hoisted` if the fixture must vary). ink maps `\x04`→ctrl+d, `\x15`→ctrl+u.

```tsx
it("^d retires a stale status message like j/k do", async () => {
  const inst = renderApp();
  inst.stdin.write("r"); await tick();          // sets "refreshed"
  expect(inst.lastFrame()).toContain("refreshed");
  inst.stdin.write("\x04"); await tick();        // ctrl+d
  expect(inst.lastFrame()).not.toContain("refreshed");
  expect(inst.lastFrame()).toMatch(/\d+ rows ·/); // fell back to the live indicator
});

it("^d in move mode does not move the hidden browse cursor", async () => {
  const inst = renderApp();
  inst.stdin.write("j"); await tick();
  inst.stdin.write("m"); await tick();           // enter move mode (fixture: 2 windows)
  const before = inst.lastFrame();
  inst.stdin.write("\x04"); await tick();
  expect(inst.lastFrame()).toBe(before);         // byte-identical frame: nothing moved
});
```

- [ ] **Step 2: Run to verify both fail**

Run: `pnpm --filter browser-tab-mcp exec vitest run src/tui/App.halfpage.test.tsx`
Expected: FAIL — first keeps "refreshed", second's frame changes (cursor highlight moved under the modal).

- [ ] **Step 3: Fix**

Replace lines 125-126 with a shared helper mirroring `onMove`'s browse branch:

```tsx
const halfPage = (dir: 1 | -1) => {
  if (mode.kind !== "browse") return; // modal lists are shorter than a page; ^d/^u steer nothing there
  setMessage("");
  setCursor((c) => Math.max(0, Math.min(rows.length - 1, c + dir * Math.floor(viewport / 2))));
};
```

wire `onHalfPageDown: () => halfPage(1), onHalfPageUp: () => halfPage(-1),` and reword the 108-110 comment to "Any browse-mode motion retires…" so it stops over-claiming. (Task 7 later replaces all of this with `navReduce`; the test written here is what survives and guards that port.)

- [ ] **Step 4: Run tests**

Run: `pnpm --filter browser-tab-mcp exec vitest run src/tui/`
Expected: PASS, including the untouched move/width/height suites.

- [ ] **Step 5: Commit**

```bash
git add apps/browser-tab-mcp/src/tui/App.tsx apps/browser-tab-mcp/src/tui/App.halfpage.test.tsx
git commit -m "fix(tui): half-page motions clear the status message, respect modal modes, clamp consistently"
```

---

### Task 4: Polish — entering confirm-close retires the stale message

**Files:**
- Modify: `apps/browser-tab-mcp/src/tui/App.tsx:206`
- Test: extend `apps/browser-tab-mcp/src/tui/App.halfpage.test.tsx` (rename mentally to "message hygiene"; keep the filename)

The bug: `x` enters confirm-close WITHOUT clearing `message` (unlike `a` at :217 and `m` at :230), so after the prompt exits, the pre-prompt stale message resurfaces in the status bar.

**DO NOT** clear `message` on mode EXITS (the `setMode({kind:"browse"})` sites at 135/140/156/163/171) or inside `runCommand` — the async `${verb} ✓` / `${verb} failed:` at App.tsx:93/95 lands AFTER the exit has run, and an exit-side clear implemented as an effect can race it. Erasing a `close` failure message makes a failed close look like it worked. Entry-side clears only.

- [ ] **Step 1: Write the failing test**

```tsx
it("entering confirm-close retires the stale message (no resurface on exit)", async () => {
  const inst = renderApp();
  inst.stdin.write("r"); await tick();           // "refreshed"
  seekToTabRow(inst);                            // j until a tab row (x only arms on tabs)
  inst.stdin.write("x"); await tick();
  expect(inst.lastFrame()).toContain("press y to confirm");
  inst.stdin.write("n"); await tick();           // any non-y exits
  expect(inst.lastFrame()).not.toContain("refreshed");
});
```

- [ ] **Step 2: Run to verify it fails** — "refreshed" resurfaces after `n`.

- [ ] **Step 3: Fix** — at App.tsx:206, mirror the `a`/`m` pattern: `setMessage("");` immediately before `setMode({ kind: "confirm-close", … })`.

- [ ] **Step 4: Run the TUI suite** — PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/browser-tab-mcp/src/tui/App.tsx apps/browser-tab-mcp/src/tui/App.halfpage.test.tsx
git commit -m "fix(tui): entering confirm-close retires the stale status message"
```

---

### Task 5: Fix the stress harness width measure BEFORE any padding lands

**Files:**
- Modify: `apps/browser-tab-mcp/scripts/stress-tui-workload.tsx:61-62` and `:250`

**Ordering constraint (why this task precedes Task 6):** the workload measures `strip(line).length` — UTF-16 code units. Today rows are unpadded and short, so the overcount (a ZWJ family emoji is ~7 code units but 2 cells) never crosses `columns`. The moment Task 6 pads rows to exactly `usableCols` cells, any emoji row measures LONGER than `columns` in code units → phantom violations → red harness on a correct layout.

- [ ] **Step 1: Switch the measure to cells**

Add `visualWidth` to the tui-kit import at `:49` and change the phase-B check (`:250`):

```tsx
const width = visualWidth(strip(line));
```

- [ ] **Step 2: Run the harness (should stay green pre-padding)**

Run: `pnpm --filter @george43g/browser-tab-mcp stress:tui`
Expected: PASS, samples > 0 (zero samples is a FAILURE per the harness contract).

- [ ] **Step 3: Sabotage-check the measure**

Temporarily, in the phase-B loop just after `strip`: `if (frames === 3) lines[0] += "北北";` (4 cells of CJK). Run the harness — MUST report a width violation. Revert the sabotage line; run `git diff scripts/stress-tui-workload.tsx` and confirm only the intended measure change remains.

- [ ] **Step 4: Commit**

```bash
git add apps/browser-tab-mcp/scripts/stress-tui-workload.tsx
git commit -m "fix(stress): TUI workload measures line width in terminal cells, not UTF-16 units"
```

---

### Task 6: `row-layout.ts` — kill the hand-rolled width math

**Files:**
- Create: `apps/browser-tab-mcp/src/tui/row-layout.ts`
- Create: `apps/browser-tab-mcp/src/tui/row-layout.test.ts`
- Modify: `apps/browser-tab-mcp/src/tui/App.tsx:250-283` (renderRow delegates)

**Interfaces:**
- Consumes: `Row` from `./rows.js`, `tabBadges` from `./rows.js`, kit `allocateWidths`/`fitToWidth`/`visualWidth`.
- Produces: `layoutRowText(row: Row, opts: {cols: number; moveTarget: boolean}): string` — returns a string of EXACTLY `cols` cells (`visualWidth === cols`, padded). Task 8/9 consume this signature.

What dies: the hand-copied `fixed` skeleton at App.tsx:264 (a duplicate of the template with the title removed — the documented drift trap) and the 55/45 split at :274-276. What changes visibly: rows are now PADDED to full width, so the cursor/target `backgroundColor` highlight extends across the row — intended improvement; note it in the PR body.

- [ ] **Step 1: Write the failing property test**

```ts
import { visualWidth } from "@george43g/tui-kit";
import { layoutRowText } from "./row-layout.js";
// build one row of each kind via @george43g/test-kit factories, with adversarial
// titles: "", 300-char ascii, "日本語のタイトルが長い場合", "👨‍👩‍👧‍👦 family 🇦🇺 flags", lone-surrogate "\ud83d".
const CASES = [browserRow, windowRow, windowRowUntitled, tabRow, tabRowEmoji, tabRowCjk];
it("every row is exactly cols cells at every width 20..200", () => {
  for (let cols = 20; cols <= 200; cols++) {
    for (const row of CASES) {
      expect(visualWidth(layoutRowText(row, { cols, moveTarget: false }))).toBe(cols);
    }
  }
});
it("the move-target marker never breaks the width contract", () => {
  for (const cols of [20, 40, 80, 156, 200])
    expect(visualWidth(layoutRowText(windowRow, { cols, moveTarget: true }))).toBe(cols);
});
```

- [ ] **Step 2: Run to verify it fails** — module doesn't exist.

- [ ] **Step 3: Implement**

```ts
import { allocateWidths, fitToWidth, visualWidth } from "@george43g/tui-kit";
import { type Row, tabBadges } from "./rows.js";

export function layoutRowText(row: Row, opts: { cols: number; moveTarget: boolean }): string {
  const { cols } = opts;
  if (row.kind === "browser") {
    const tabs = row.browser.windows.reduce((a, w) => a + w.tabCount, 0);
    const src = row.browser.extensionConnected ? "extension" : "applescript";
    const text = `▸ ${row.browser.browser} — ${row.browser.windows.length} windows, ${tabs} tabs [${src}]${row.browser.error ? " ⚠" : ""}`;
    return fitToWidth(text, cols);
  }
  if (row.kind === "window") {
    // Compose prefix/suffix ONCE and derive the title budget from the real
    // strings — the old code kept a hand-copied `fixed` skeleton that drifted.
    const fold = row.folded ? "▸" : "▾";
    const cg = row.window.cgWindowId !== null ? ` cg=${row.window.cgWindowId}` : " cg:none";
    const prefix = `  ${fold} `;
    const suffix = ` — ${row.window.tabCount} tabs${cg}${opts.moveTarget ? " ◀ move here" : ""}`;
    const titleW = Math.max(8, cols - visualWidth(prefix) - visualWidth(suffix));
    return fitToWidth(prefix + fitToWidth(row.window.title || "(untitled)", titleW) + suffix, cols);
  }
  const marker = row.tab.active ? "●" : "·";
  const badges = tabBadges(row.tab, row.browser.tabGroups);
  const prefix = `      ${marker} `;
  const suffix = badges ? `  ${badges}` : "";
  const budget = Math.max(10, cols - visualWidth(prefix) - visualWidth(suffix));
  // Title and URL compete; the URL is elaboration and DROPS when starved.
  const alloc = allocateWidths(budget, [
    { id: "title", min: 8, preferred: Math.min(50, Math.ceil(budget * 0.55)), priority: 1, collapse: "min" },
    { id: "url", min: 12, preferred: Math.min(60, budget), priority: 0, collapse: "drop" },
  ]);
  const titleW = alloc.widths.title ?? Math.max(8, budget);
  const urlW = alloc.widths.url ?? 0;
  const title = fitToWidth(row.tab.title || "(untitled)", titleW);
  const url = urlW > 0 ? `  ${fitToWidth(row.tab.url, Math.max(0, urlW - 2))}` : "";
  return fitToWidth(prefix + title + url + suffix, cols);
}
```

Note: `Row` for windows must expose `folded` (today App computes it from the `folded` set at :259). Either pass `folded: boolean` in `opts`, or extend the window `Row` variant in `rows.ts` — pick passing it via `opts` (`{cols, moveTarget, folded?}`) to leave `rows.ts` untouched; adjust the test cases accordingly.

- [ ] **Step 4: Run the property test** — PASS at all 181 widths × all cases.

- [ ] **Step 5: Wire into App.tsx**

`renderRow` keeps only: `const text = layoutRowText(row, { cols: usableCols, moveTarget: isMoveTarget(row), folded: … });` plus the existing color/highlight `<Text>` wrapper (keep `wrap="truncate"` as belt-and-braces). Delete lines 252-283's hand math. The final unconditional `truncateToWidth(text, usableCols)` clamp is now redundant but harmless — keep it for one release as a second belt.

- [ ] **Step 6: Full TUI gates**

Run: `pnpm --filter browser-tab-mcp exec vitest run src/tui/ && pnpm --filter @george43g/browser-tab-mcp stress:tui`
Expected: PASS. The width suite (7 geometries) and stress phase B (6 geometries, cell-measured since Task 5) are the guards for exactly this change.

- [ ] **Step 7: Commit**

```bash
git add apps/browser-tab-mcp/src/tui/row-layout.ts apps/browser-tab-mcp/src/tui/row-layout.test.ts apps/browser-tab-mcp/src/tui/App.tsx
git commit -m "refactor(tui): row layout onto tui-kit fitToWidth/allocateWidths — exact-width rows, no hand skeleton"
```

---

### Task 7: Cursor onto `navReduce`

**Files:**
- Modify: `apps/browser-tab-mcp/src/tui/App.tsx` (cursor state + the four motion handlers + rows-change effect)
- Create: `apps/browser-tab-mcp/src/tui/App.nav.test.tsx`

**Interfaces:**
- Consumes: kit `navReduce`, `NavState`; Task 3's `App.halfpage.test.tsx` (must stay green — it pins the modal guard and message clearing across this port).
- Produces: cursor state as `NavState`; a `dispatchNav(intent)` helper other handlers call.

Two behavioral deltas, both intended: (a) all four motions share ONE clamp (the reducer's); (b) on snapshot change the cursor follows the ROW (by `key`), not the numeric index — `itemsReplaced` with a key-based remap. Keys stay app-side: `useVimKeys` remains the decoder; `navReduce` is only the state math.

- [ ] **Step 1: Write the failing tests**

```tsx
it("Enter acts on the row the highlight shows (cursor↔action agreement)", async () => {
  // vi.mock ../client/tabs-service.js with a recording focusTab fake.
  const inst = renderApp();
  inst.stdin.write("j"); inst.stdin.write("j"); await tick();
  inst.stdin.write("\r"); await tick();
  expect(focusCalls[0].tabId).toBe(tabIdOfRow(2)); // the fixture row j-j landed on
});

it("cursor follows its row when the snapshot changes shape", async () => {
  const inst = renderApp();                        // vi.hoisted fixture: rows shift when state.extraWindow flips
  seekTo(inst, "target-tab"); await tick();
  state.extraWindow = true; refreshSnapshot(); await tick(); // a window opens ABOVE the cursor
  expect(highlightedRow(inst)).toContain("target-tab");     // still on the same tab, index moved
});
```

The first test closes the gap the exploration flagged: NO existing test asserts the highlighted row and the acted-on row agree, and the blast radius of getting this port wrong is `x` closing a different tab than highlighted.

- [ ] **Step 2: Run to verify the second fails** (the first should pass pre-port — it pins current behavior; if it fails pre-port, stop: that's a live bug, report before proceeding).

- [ ] **Step 3: Port**

```tsx
const [nav, setNav] = useState<NavState>({ cursor: 0, count: null, touched: false });
const navCtx = { itemCount: rows.length, pageSize: Math.floor(viewport / 2) }; // pageSize = half-page, preserving ^d/^u distance
const dispatchNav = (intent: NavIntent) => setNav((s) => navReduce(s, intent, navCtx));
```

- `onMove(delta)` browse branch → `setMessage(""); dispatchNav({ kind: "set", index: nav.cursor + delta });` (`set` clamps in the reducer).
- `onTop`/`onBottom` → `top`/`bottom` intents (+ `setMessage("")`).
- `halfPage(dir)` → `pageDown`/`pageUp` intents (+ guard + clear from Task 3).
- Rows-change effect (replaces the derived `clampedCursor`):

```tsx
const prevRowsRef = useRef(rows);
useEffect(() => {
  const prev = prevRowsRef.current;
  if (prev !== rows) {
    prevRowsRef.current = rows;
    setNav((s) =>
      navReduce(s, {
        kind: "itemsReplaced",
        remap: (old) => {
          const key = prev[old]?.key;
          const idx = key ? rows.findIndex((r) => r.key === key) : -1;
          return idx >= 0 ? idx : Math.min(old, Math.max(0, rows.length - 1));
        },
      }, { itemCount: rows.length, pageSize: Math.floor(viewport / 2) }),
    );
  }
}, [rows]);
```

`clampedCursor` becomes `nav.cursor` — update its three consumers together (`current` :60, `focusRow` :246, `isCursor` :251); they are the agreement the first test pins.

- [ ] **Step 4: Run the full TUI suite + both new tests** — PASS, including Task 3's tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/browser-tab-mcp/src/tui/App.tsx apps/browser-tab-mcp/src/tui/App.nav.test.tsx
git commit -m "refactor(tui): cursor state onto tui-kit navReduce; cursor follows its row across snapshot changes"
```

---

### Task 8: Scrollbar

**Files:**
- Modify: `apps/browser-tab-mcp/src/tui/App.tsx` (list render), `apps/browser-tab-mcp/src/tui/row-layout.test.ts` (width contract unchanged — rows still exact-width, one col narrower)
- Test: extend `apps/browser-tab-mcp/src/tui/App.test.tsx`

Design: a 1-column track at the right edge of the list, rendered ONLY when `rows.length > viewport` (when `scrollbarThumb` returns `thumbRows === 0`, render no track at all — rows keep full width). Glyphs: thumb `█` (theme accent), track `│` (dim). The row text budget becomes `usableCols - 2` (1 track + 1 gap) when the track is visible.

- [ ] **Step 1: Write the failing test**

```tsx
it("shows a scrollbar thumb when rows exceed the viewport, none when they fit", async () => {
  state.tabsPerWindow = 40;                       // vi.hoisted — overflow the 24-row terminal
  const { lines } = await renderAt(100, 24);
  expect(lines.some((l) => strip(l).endsWith("█"))).toBe(true);
  state.tabsPerWindow = 2;                        // fits
  const { lines: fit } = await renderAt(100, 24);
  expect(fit.some((l) => strip(l).includes("█"))).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement**

```tsx
const thumb = scrollbarThumb({ start: visibleStart, end: visibleEnd, total: rows.length }, viewport);
const showBar = thumb.thumbRows > 0;
const rowCols = showBar ? usableCols - 2 : usableCols;
// per visible row i (0-based within the window):
const barChar = !showBar ? "" :
  i >= thumb.thumbStart && i < thumb.thumbStart + thumb.thumbRows ? "█" : "│";
```

Render each list line as row text (`layoutRowText(row, { cols: rowCols, … })`) plus `<Text> </Text>` gap plus the bar glyph — keeping every printed line exactly `usableCols` cells so the width invariants hold.

- [ ] **Step 4: Run TUI suite + stress:tui** — PASS (stress geometries 40×12…200×60 all exercise both branches: small fixture counts fit at 60 rows? If EVERY geometry overflows with the fake-adapter scale, the no-bar branch is only covered by the unit test — acceptable, say so in the PR body rather than pretending otherwise).

- [ ] **Step 5: Commit**

```bash
git add apps/browser-tab-mcp/src/tui/App.tsx apps/browser-tab-mcp/src/tui/App.test.tsx
git commit -m "feat(tui): scroll position indicator via tui-kit scrollbarThumb"
```

---

### Task 9: Sticky detail pane (drops when narrow)

**Files:**
- Create: `apps/browser-tab-mcp/src/tui/DetailPane.tsx`
- Modify: `apps/browser-tab-mcp/src/tui/App.tsx` (top-level layout)
- Test: `apps/browser-tab-mcp/src/tui/App.detail.test.tsx`

Design (from the 0.5.0 negotiation, recorded in `width-alloc.d.ts` verbatim): the detail pane is ELABORATION — its degraded form is ABSENCE. Allocation:

```tsx
const alloc = allocateWidths(usableCols, [
  { id: "list", min: 44, preferred: Math.ceil(usableCols * 0.65), priority: 1, collapse: "min" },
  { id: "detail", min: 28, preferred: Math.floor(usableCols * 0.35), priority: 0, collapse: "drop" },
]);
const detailW = alloc.widths.detail ?? 0; // absent = dropped
```

At 80 cols: 44 + 28 = 72 < 80 → both present. At <74 (44+28+2 gap): detail drops, list takes everything — including the slack (the allocateWidths growth-cap defect was found and fixed before 0.5.0 shipped; the list DOES absorb the freed width). `CHROME_ROWS` unchanged — this is horizontal, zero new chrome lines.

DetailPane content, every line `fitToWidth(line, detailW)`:
- tab row: full title (2 lines max), full url (2 lines max), state badges spelled out (audio/muted/pinned/discarded/frozen), group title+color, `lastAccessed` as relative time, window title, browser.
- window row: title, bounds, `cgWindowId`, state, tab count, active tab title.
- browser row: source, capability summary (`n/m capabilities`), error if any.

- [ ] **Step 1: Write the failing test**

```tsx
const SLOW_RENDER_MS = 30_000; // geometry loop — Windows runners need it
it("detail pane present when wide, dropped when narrow", async () => {
  const wide = await renderAt(160, 30);
  expect(wide.lines.join("\n")).toContain("┃");            // pane separator glyph
  expect(wide.lines.every((l) => visualWidth(strip(l)) <= 160)).toBe(true);
  const narrow = await renderAt(70, 30);
  expect(narrow.lines.join("\n")).not.toContain("┃");      // dropped entirely, no breadcrumb
}, SLOW_RENDER_MS);
```

- [ ] **Step 2: Run to verify it fails.**

- [ ] **Step 3: Implement** — App's list `<Box>` becomes `flexDirection="row"`: list column (width `alloc.widths.list`), separator `┃` column, `<DetailPane row={current} cols={detailW - 2} />` when `detailW > 0`. The scrollbar (Task 8) lives inside the LIST column; its `rowCols` derives from `alloc.widths.list`. The detail pane renders at most `viewport` lines (its content is line-clamped, never taller than the list).

- [ ] **Step 4: Run the FULL gate stack** — `pnpm --filter browser-tab-mcp exec vitest run src/tui/ && pnpm --filter @george43g/browser-tab-mcp stress:tui`. The stress geometries now exercise the pane at 200×60/120×40 and the drop at 80×24 and below. Any frame-height violation here is REAL — chrome must still sum to 4.

- [ ] **Step 5: Commit**

```bash
git add apps/browser-tab-mcp/src/tui/DetailPane.tsx apps/browser-tab-mcp/src/tui/App.tsx apps/browser-tab-mcp/src/tui/App.detail.test.tsx
git commit -m "feat(tui): sticky detail pane via allocateWidths — elaboration drops when narrow"
```

---

### Task 10: Docs + full verify + PR

**Files:**
- Modify: `apps/browser-tab-mcp/README.md` (TUI section: scrollbar, detail pane, cursor-follows-row), `AGENTS.md` (stress:tui paragraph: the width measure is now cell-based)

- [ ] **Step 1: Update README + AGENTS.md** as above (readme-check gate: this PR touches `src/**`, so the README change is mandatory, no `[skip-readme]`).
- [ ] **Step 2: Full gates**: `pnpm verify && pnpm --filter @george43g/browser-tab-mcp stress:tui` — all green. On macOS the pre-push hook runs `pnpm verify:macos`.
- [ ] **Step 3: Live drive** (manual, 2 min): `pnpm --filter browser-tab-mcp tui` against the real daemon — j/k/^d/^u/gg/G, fold, `m` move flow, `x` cancel, resize the terminal below 74 cols and watch the pane drop cleanly.
- [ ] **Step 4: Push branch `feat/tui-primitives-port`, open PR** titled `feat(tui): port to tui-kit 0.5.0 primitives — scrollbar, detail pane, nav reducer + 4 polish fixes`. George's word gates the merge.
