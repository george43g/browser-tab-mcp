# Paste-able handoff message

Copy everything below the line into the agent working on
`mcp-cli-starter-template`. It assumes that agent has the template repo checked
out and can read this repo's files if pointed at them; if it cannot, attach
`UPSTREAM-KIT-BRIEF.md` and the two reference files named below.

---

I maintain `browser-tab` (`github.com/george43g/browser-tab-mcp`), which was
scaffolded from `mcp-cli-starter-template` and consumes the
`@george43g/{cli-kit,tui-kit,robustness}` packages you publish. I've been
dogfooding the template hard and found six things worth fixing upstream. Full
write-up with repro steps, file/line references and suggested contracts:

**`docs/agent-handoff/UPSTREAM-KIT-BRIEF.md`** in the browser-tab repo.

They split into two classes with different urgency:

**Class A — published packages. This is the critical path and it's blocking me.**

1. `cli-kit` `parseConsoleInput` (`src/repl.ts` ~line 60) consumes quote
   characters as shell quoting, so any JSON argument is destroyed before the
   caller sees it. `raw {"name":"x"}` reaches `JSON.parse` as `{name:x}`.
   Backslash escapes aren't handled either, so there's no escape hatch. **The
   `raw` command cannot function at all.**
2. `cli-kit` `runRepl` never implements the `<tool> <json>` dispatch its own
   docblock promises — it throws `Unknown command`. Meanwhile `help` lists every
   registered tool under "Available MCP tools:", so it advertises 18 callable
   tools when 3 are callable.
3. `tui-kit` has no terminal-size hook, so every consumer hardcodes a viewport
   height. I have a working `useTerminalSize` you can lift verbatim from
   `apps/browser-tab-mcp/src/tui/useTerminalSize.ts`.

I verified 1 and 2 against the **published** tarballs, not just my workspace
copies — they're in `cli-kit@0.1.0/dist/repl.js` verbatim. I am deliberately
**not** patching these locally, because a local patch would diverge from npm and
be thrown away on migration. So my REPL stays broken until you publish. Items 1
and 2 are the ones I actually need; 3 is a nice-to-have I've worked around.

Please bump minor and publish when 1–2 are fixed. Nothing else in those packages
needs to change — `output.ts` and `env-flag-binder.ts` are correct and I'm
adopting them as-is.

**Class B — template source. Not blocking me, but every repo you scaffold
inherits these.**

4. **Build identity.** I added a build stamp
   (`<semver>+<count>.<sha>[.dirty.<ts>]`, ~60 dependency-free lines) because
   semver can't distinguish two builds between releases — which is how a
   rebuilt-but-never-reloaded browser extension keeps reporting a plausible
   version. It caught me verifying against the wrong bundle twice in one
   session. Generic enough to belong in the template. Reference implementation:
   `scripts/build-stamp.mjs`.

   **One hard constraint if you adopt it:** don't put the stamp *reader* in a
   published package. The value arrives via Vite `define`, which only substitutes
   into code Vite transforms — a published package is built by its own `tsc` and,
   once it's an external dep, Vite never sees it. It would silently report `+dev`
   forever with no error. Inject the value; don't read a compile-time global from
   inside a package.
5. **`turbo.json` can replay a stale build stamp**, which undermines the above.
   Git state isn't in `build.inputs`, so a docs-only commit + rebuild serves
   cached `dist/` still claiming the previous sha. Separately,
   `scripts/build-stamp.mjs` is at the repo root and `globalDependencies` doesn't
   cover `scripts/**`, so editing the generator invalidates nothing. The brief
   lays out the fix options and their CI-time tradeoff.
6. **`packages/vitest-config`** — `vitest.shared.ts:18` includes
   `src/**/*.test.tsx` but only `tests/**/*.test.ts`. A React/Ink integration
   test under `tests/`, which your own four-layer test taxonomy tells people to
   write, is silently never collected. One-line fix.

I'll fix 5 and 6 in my own tree regardless, but they should land upstream so
fresh scaffolds aren't born with them.

One sequencing note: my migration onto the published packages is what turns
`@george43g/*` into real external deps — which is exactly the condition that
breaks a badly-placed build-stamp reader. If you do both, get item 4's design
right first.
