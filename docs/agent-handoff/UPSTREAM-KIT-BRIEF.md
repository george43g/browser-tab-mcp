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

## 4. `watchdog`: sustained event-loop lag cannot distinguish a WEDGED process from a STARVED one

**Reported 2026-08-24. Affects `@george43g/robustness@0.12.0` (and 0.11.0 — this
is not a stale-consumer problem).** Two independent consumers hit it on the same
machine in the same window: `browser-tab-mcp` and `up-bank-mcp`.

**Symptom.** browser-tab's daemon self-killed **126 times**, every death
`watchdog_kill: event_loop_sustained_lag`, launchd respawning each time on a 10s
cycle. Nothing was wrong with the daemon.

**Measurement that settles it.** The daemon, while logging `event_loop_lag` at
p99 1885ms:

```
$ ps -o pid,%cpu,etime,time -p 16323
  PID  %CPU  ELAPSED      TIME
16323   0.0 01:19:35   0:27.26
```

27.26s of CPU across 79m35s wall — a **0.57% duty cycle**. The host was at load
20-24 (118 node/claude processes, 3.5GB resident); `pmset -g log` showed no
sleep/wake in the window. The process was not stalling, it was **not being
scheduled**.

**The defect.** Event-loop lag alone cannot tell "my code blocked the loop" from
"the OS didn't schedule me" — the two are indistinguishable from inside the
process unless you also measure CPU. `dist/watchdog.js:171-172` fires
`triggerKill("event_loop_sustained_lag", …)` with no notion of whether the
process was ever on-CPU:

```
$ grep -c 'cpuUsage\|loadavg' .../@george43g+robustness@0.12.0/dist/watchdog.js
0
```

**Asked for — two signals with defined roles, not one.** Sample
`process.cpuUsage()` across the lag window; consult `os.loadavg()[0] /
os.cpus().length` only for the branch CPU cannot resolve:

| lag observed | CPU during the window | meaning | action |
|---|---|---|---|
| sustained | **high** | spinning on its own work — wedged | **kill** |
| sustained | **low** + host saturated | starved by the host | **log, do not kill** |
| sustained | **low** + host idle | blocked in a sync syscall | **kill** |

**Why not `cpuUsage` alone** (this repo argued for that first, then refuted it):
a process blocked in a *synchronous syscall* is wedged and off-CPU. browser-tab
makes that reachable — `src/detect/correlate.ts:169` is a synchronous napi call
into `CGWindowListCopyWindowInfo`, a Mach IPC round-trip to WindowServer, and
`daemon/journal.ts:266`, `daemon/annotations.ts:70`, `daemon/window-shot.ts:57`
are synchronous `readFileSync`. A pure duty-cycle test reads a hung WindowServer
as "starved, don't kill" and leaves the process wedged forever — the exact
failure the watchdog exists to prevent.

**Why not `loadavg` alone** (up-bank's first proposal, withdrawn): a machine can
be at load 24 while a specific process is genuinely wedged. Load-aware gating
suppresses the kill exactly then. Under the table above it cannot — high host
load only ever downgrades a kill when the process is **also** off-CPU, and a
spinning wedge is on-CPU regardless of the host.

**Certainty.** The duty-cycle measurement and the absent `cpuUsage`/`loadavg`
symbols are verified. That `CGWindowListCopyWindowInfo` hangs long enough to
trip a sustained-lag window is **inference** from its being a synchronous IPC
round-trip — not observed. The design deliberately does not depend on that hang
being common: it holds because "low CPU" has two causes and only one is safe to
ignore.

**Blast radius if unfixed.** Every consumer on a shared or loaded machine
euthanises itself under someone else's CPU pressure, and the label sends
maintainers hunting a performance bug in their own code that the evidence never
supported. That cost is epistemic, not operational — the restart itself is cheap
(~28MB RSS, sub-second start). Two sessions spent an evening on it here.

**Attribution.** Mechanism (duty-cycle) from browser-tab; the second consumer
and the `loadavg` branch from up-bank; host measurements (`pmset`, load) from the
dotfiles session, which held both reports and is the only reason the two repos
filed one brief instead of two competing ones.

---

## After a publish

Ask browser-tab to migrate: swap the three workspace packages for
`^0.2.0` (or whatever ships), delete `packages/{cli-kit,tui-kit,robustness}`,
and re-point `pnpm-workspace`/tsconfig references. `mcp-kit`, `shared-types`,
`test-kit`, `env-loader` and `secrets` are unpublished and stay in-tree.

Until then browser-tab's REPL remains broken (items 1–2) by deliberate choice —
see `DECISIONS.md`.
