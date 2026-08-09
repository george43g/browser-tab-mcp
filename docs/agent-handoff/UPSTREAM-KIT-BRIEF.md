# Upstream brief — `mcp-cli-starter-template` kit fixes

> **Audience:** the agent maintaining
> `github.com/george43g/mcp-cli-starter-template`, which publishes
> `@george43g/{cli-kit,tui-kit,robustness}` to npm.
>
> **Why this file exists:** browser-tab is migrating from its workspace copies
> of these packages to the published ones. Fixing them in browser-tab's tree
> would diverge from npm and be lost on migration, so defects found while
> dogfooding are reported here instead. **browser-tab is NOT patching these
> locally** — it waits for a publish.

Found during a live bug sweep of browser-tab on 2026-08-07/09. Verified against
the **published** tarballs (`@george43g/cli-kit@0.1.0`, `tui-kit@0.1.1`,
`robustness@0.2.1`), not just the workspace copies — items 1 and 2 are present
verbatim in `cli-kit@0.1.0/dist/repl.js`.

**Priority for a `cli-kit@0.2.0`:** items 1 and 2 are blocking (the REPL cannot
function at all). Items 3 and 5 are quality-of-life. Item 4 requests no change
but flags which API is now load-bearing for browser-tab.

---

## 1. `cli-kit` — `parseConsoleInput` destroys any JSON argument (blocking)

**File:** `packages/cli-kit/src/repl.ts` (~line 60), shipped in `0.1.0`.

The tokenizer treats `"` and `'` as shell quoting and **consumes every quote
character**, so a JSON payload is mangled before the caller ever sees it:

```
browser-tab> raw {"name":"daemon_status","arguments":{}}
Expected property name or '}' in JSON at position 1 (line 1 column 2)
```

`{"name":…}` arrives at `JSON.parse` as `{name:…}`. There is no escape hatch —
backslash escapes are not handled either, so `raw {\"name\":\"x\"}` fails
identically. **`raw` cannot function at all**, which matters because it is the
only documented way to reach a tool that has no registered shortcut.

**Asked for:** a tokenizer that splits on whitespace *outside* quotes while
**preserving** the quote characters inside an argument, plus backslash-escape
support. Splitting for shell-style args and preserving a JSON payload are
different jobs; the current function tries to do both and does neither.

Suggested contract:

```
raw {"name":"x","arguments":{"a":1}}   → args[0] === '{"name":"x","arguments":{"a":1}}'
foo "two words" bar                    → ["two words", "bar"]
foo "she said \"hi\""                  → ['she said "hi"']
```

## 2. `cli-kit` — `runRepl` never implements its documented `<tool> <json>` dispatch

**File:** same, docblock at ~line 8 promises it; ~line 173 throws
`Unknown command`.

Only `help`, `tools`, `raw`, `quit`/`exit` and registered shortcuts dispatch.
But `help` prints **every** tool under a heading reading *"Available MCP
tools:"*, so it advertises 18 callable tools when 3 are callable:

```
browser-tab> daemon_status
Unknown command: daemon_status. Type 'help' for available commands.
```

**Asked for:** either implement the promised generic dispatch (look the name up
via `dispatcher.listTools()` and parse the remainder as JSON args), or stop
listing uncallable tools under that heading. Implementing it is preferred —
`raw` becomes a fallback rather than the only route.

Note this cannot be worked around by a consumer: `buildArgs` receives args
*after* item 1 has already stripped the quotes, so no shortcut registration can
recover the JSON.

## 3. `tui-kit` — no terminal-size hook

`0.1.1` ships `useVimKeys`, `useDevStats`, `useMouse` — nothing exposes
terminal dimensions. Ink re-renders on resize but never tells a component how
many rows it has, so every consumer that slices its own scroll window has to
hardcode a height. browser-tab shipped `const VIEWPORT = 24` for exactly this
reason; on a 50-row terminal it wasted 22 rows, and below ~28 rows it
overflowed the flex container and overprinted the status bar.

**Asked for:** `useTerminalSize(): { rows: number; columns: number }` — reads
`useStdout().stdout`, subscribes to `resize`, falls back sanely when stdout
reports nothing (piped, or a test stub). browser-tab has a working
implementation at `apps/browser-tab-mcp/src/tui/useTerminalSize.ts` that can be
lifted verbatim.

Related, worth considering upstream: `ink-testing-library` is already a
`tui-kit` devDependency but **no render tests use it**. Its fake stdout has a
getter-only `columns` and no `rows` at all, so a hook like the above is
awkward to test until `render()` accepts stdout overrides.

## 4. No change requested — adopting as-is

`cli-kit`'s `output.ts` (`printTable`/`printAuto`/`printJson`/
`resolveOutputMode`) and `env-flag-binder.ts` are **correct and useful**. They
were simply never called by browser-tab, which is a browser-tab bug, not a kit
bug — it is wiring them up now. No API change wanted.

**Update (PR #26, 2026-08-09):** that wiring has landed, so these are no longer
hypothetical adoption — `resolveOutputMode`, `printJson`, `bindEnvFlags` and
`applyEnvFromFlags` are now on browser-tab's hot path for every read command.
Treat them as **load-bearing** when versioning `cli-kit`: a behaviour change to
output-mode precedence or to flag-name derivation (`strip prefix → lowercase →
`_`→`-`) is a breaking change for us, not a patch.

## 5. `resolveOutputMode` has no way to force human output

`resolveOutputMode` returns `"json"` for `--json`, a non-TTY stdout, **or**
`CI=true`, and `"human"` otherwise. There is no inverse of `--json`, so a
human-rendered view is unreachable the moment stdout is not a terminal.

That is right for the default, but it makes the human path awkward to test and
impossible to capture: browser-tab had to run its CLI under a pty (`script -q
/dev/null …`) just to see its own tree renderer, and a user cannot do the
obvious `browser-tab list | less`.

**Asked for:** an explicit opt-in that outranks the implicit signals — either a
`human?: boolean` field on `OutputFlags` (so consumers can bind `--no-json` /
`--human`), or honouring `FORCE_COLOR`-style precedence with a documented
`FORCE_HUMAN`/`--human`. Low priority next to items 1–2, and browser-tab is
**not** working around it locally.

---

## After a publish

Ask browser-tab to migrate: swap the three workspace packages for
`^0.2.0` (or whatever ships), delete `packages/{cli-kit,tui-kit,robustness}`,
and re-point `pnpm-workspace`/tsconfig references. `mcp-kit`, `shared-types`,
`test-kit`, `env-loader` and `secrets` are unpublished and stay in-tree.

Until then browser-tab's REPL remains broken (items 1–2) by deliberate choice —
see `DECISIONS.md`.
