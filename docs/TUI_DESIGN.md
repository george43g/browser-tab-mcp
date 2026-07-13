# TUI design

The starter ships a working Ink/React TUI that demos the patterns. Tools that don't need a TUI can delete `apps/browser-tab-mcp/src/tui/` and the `browser-tab-tui` bin entry; everything else still works.

## Theme system

Single source of truth: `packages/tui-kit/src/theme/`.

- **palette.ts** — accent-driven HSL derivation. Pass a single hex (default `#1982FC`); the palette derives bg/fg/borders/dim variants from it. Semantic colors (success/warning/danger/info) stay at canonical hues so they're readable across any accent.
- **glyphs.ts** — two presets: `safe` (geometric shapes + emoji, renders in any modern terminal) and `powerline` (Nerd Font icons, requires a patched font).
- **color.ts** — pure HSL math (hexToHsl, hslToHex, contrastRatio, withL, withS, rotateHue, tint). Unit-tested.
- **ThemeContext.tsx** — React Context. Hosts wrap their root in `<ThemeProvider preset accent>`; components call `useTheme()`.

## Selecting a theme at runtime

Two knobs, both env-driven (and CLI-flaggable via `@george43g/cli-kit`):

- `MCP_TUI_THEME` — `safe` (default) or `powerline`
- `MCP_TUI_ACCENT` — any 7-char hex, defaults to `#1982FC`

The TUI entry reads these at startup and passes them to `<ThemeProvider>`.

## Reusable hooks

`packages/tui-kit/src/hooks/`:

- **useVimKeys** — number-buffer prefix + `gg` double-press + j/k/G/^d/^u dispatch. Mode-aware via `enabled` boolean (suspend during modals). The starter App uses it for the demo list.
- **useMouse** — SGR mouse protocol (`?1000h` + `?1006h`). **Critical**: never enables `?1003h` (any-event tracking) — that fires on every pixel of motion and pins the event loop. The watchdog would kill the process eventually, but it's the kind of bug that takes hours to track down.
- **useDevStats** — samples `process.cpuUsage()` + `process.memoryUsage()` + watchdog state on a 2s timer. Drives the `DevStatsPanel` component.

## Reusable components

`packages/tui-kit/src/components/`:

- **DevStatsPanel** — toggleable with the `d` key in the host App. Shows pid, uptime, CPU%, heap MB, RSS MB, event-loop p99, last activity, engine label (`rust`/`ts`).
- **StatusBar** — mode indicator + message slot, with optional right-aligned hint.
- **HelpBar** — keybinding legend; pass an array of `{ key, label }`.
- **renderFullScreen** — fullscreen-ink wrapper. Integrates with the shutdown registry so the screen unmounts during graceful shutdown (signal, EOF, orphan reparent).

## Bounded-memory patterns

`packages/tui-kit/src/`:

- **MemoryCache** — TTL + memory-pressure LRU. Subscribes to `@george43g/robustness/watchdog`'s `onMemorySample()` and evicts the LRU half when heap exceeds `pressureMb`. No new sampler.
- **boundIfNeeded** — generic version of imsg-mcp's `boundMessagesIfNeeded`. When a working list exceeds `hardCap`, evict the middle while preserving the last `anchorKeep` items (so G/end-of-list is always fast) and `windowBuffer` items around the cursor. Caller supplies a `makeMarker` factory for the gap placeholder.

## TUI test pattern

The starter's `vitest.config.ts` includes `tsx` test files. Use `ink-testing-library`:

```ts
import { render } from "ink-testing-library";
import { App } from "../src/tui/App.js";

test("App renders default mode", () => {
  const { lastFrame } = render(<App />);
  expect(lastFrame()).toContain("Item");
});
```

For interactive flows, drive `stdin.write()`:

```ts
const { stdin, lastFrame } = render(<App />);
stdin.write("j"); // move cursor down
expect(lastFrame()).toContain("Item 2");
```

## Removing the TUI

1. Delete `apps/browser-tab-mcp/src/tui/`.
2. Remove `browser-tab-tui` from `apps/browser-tab-mcp/package.json`'s `bin` map.
3. Remove the `tui` subcommand from `apps/browser-tab-mcp/src/cli.ts`.
4. Remove the TUI entry from `apps/browser-tab-mcp/vite.config.ts` `lib.entry`.
5. Optionally remove `@george43g/tui-kit` from `apps/browser-tab-mcp/package.json` dependencies and from `pnpm-workspace.yaml` if no other app uses it.
