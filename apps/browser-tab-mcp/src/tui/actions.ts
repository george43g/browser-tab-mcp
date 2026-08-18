/**
 * The tab actions the TUI can run, and which of them a browser supports.
 *
 * WHY THIS IS A PICKER AND NOT MORE KEYBINDINGS. `tab_action` has ten kinds.
 * Giving each one a key would need ten more entries in the help bar, which is
 * clamped to a SINGLE row — the kit's HelpBar wraps below ~90 columns, and a
 * wrapping help bar silently steals a row from the list viewport, which is how
 * a width bug presents as a height overflow here (see App.tsx). So the actions
 * live behind one key and are chosen in the status bar, exactly as the existing
 * move-target picker does.
 *
 * WHY IT IS CAPABILITY-FILTERED. Availability is runtime-probed per browser and
 * already flows through the snapshot; offering `duplicate` on an AppleScript-only
 * Safari would produce a menu entry whose only outcome is an error toast. Gate on
 * the map, never on the browser name — the repo invariant.
 */

import type { BrowserState } from "@george43g/shared-types";

export interface TabActionChoice {
  /** The `tab_action` kind. */
  action: string;
  /** What the status bar shows. */
  label: string;
  /**
   * Capability key that must be true. Absent = always offered (`navigate` and
   * `reload` work on every pathway, including AppleScript).
   */
  needs?: string;
  /**
   * Only offer when the tab is in this state — a menu that offers both "mute"
   * and "unmute" for a silent tab is asking the user to know which one applies.
   */
  when?: (tab: { muted?: boolean; pinned?: boolean; discarded?: boolean }) => boolean;
}

export const TAB_ACTIONS: readonly TabActionChoice[] = [
  { action: "mute", label: "mute", needs: "muted", when: (t) => !t.muted },
  { action: "unmute", label: "unmute", needs: "muted", when: (t) => t.muted === true },
  { action: "pin", label: "pin", when: (t) => !t.pinned },
  { action: "unpin", label: "unpin", when: (t) => t.pinned === true },
  { action: "discard", label: "discard (sleep)", needs: "discard", when: (t) => !t.discarded },
  { action: "reload", label: "reload" },
  { action: "duplicate", label: "duplicate", needs: "duplicate" },
  { action: "back", label: "back", needs: "backForward" },
  { action: "forward", label: "forward", needs: "backForward" },
];

/**
 * The actions worth offering for this tab on this browser.
 *
 * A browser with NO capability map (a legacy extension, or a source that never
 * reported one) gets the unconditional actions only. That is deliberately
 * conservative: the daemon already defaults unknown capabilities to false
 * (`conservativeCaps`), and a menu is a promise.
 */
export function availableActions(
  browser: Pick<BrowserState, "capabilities">,
  tab: { muted?: boolean; pinned?: boolean; discarded?: boolean },
): TabActionChoice[] {
  const caps = browser.capabilities ?? {};
  return TAB_ACTIONS.filter((a) => {
    if (a.needs && caps[a.needs] !== true) return false;
    return a.when ? a.when(tab) : true;
  });
}

/** One footer hint, plus how readily it can be dropped. */
export interface Hint {
  key: string;
  label: string;
  /** Higher goes first when the bar will not fit. Absent = never dropped. */
  sacrifice?: number;
}

/**
 * The full footer, richest first in usefulness order.
 *
 * `j/k`, `⏎` and `q` carry no `sacrifice`: without them the TUI is unusable and
 * unquittable, so they survive at any width.
 */
export const ALL_HINTS: readonly Hint[] = [
  { key: "j/k", label: "move" },
  { key: "⏎", label: "focus" },
  { key: "a", label: "actions", sacrifice: 2 },
  { key: "x", label: "close", sacrifice: 3 },
  { key: "m", label: "move tab", sacrifice: 4 },
  { key: "space", label: "fold", sacrifice: 5 },
  { key: "r", label: "refresh", sacrifice: 6 },
  { key: "q", label: "quit" },
];

/**
 * The hints that FIT — dropping the least useful rather than letting the bar
 * wrap.
 *
 * WHY THIS IS NOT JUST A LONGER LIST. The kit's HelpBar is `flexWrap="wrap"`,
 * and App.tsx clamps it to `height={1}` for a reason recorded there:
 * `viewportRows()` subtracts a CONSTANT chrome height, so a bar that needs two
 * rows silently steals one from the list and pushes the frame past the screen —
 * a width bug that presents as a height overflow. Clamping means the overflow
 * is invisible instead: the hints simply fall off the right edge, and `q quit`
 * was the one that went.
 *
 * That is the same problem `layoutRow` solves for the CLI, with the same
 * answer: drop a column, never squeeze. Adding `a actions` is what made it
 * visible — the bar was already one hint from the edge.
 */
export function visibleHints(columns: number): Hint[] {
  // Modelled on what the kit ACTUALLY renders (tui-kit HelpBar): an outer Box
  // with paddingX=1, each hint in a Box with marginRight=2 as `<key> <label>`,
  // and a " · " separator between entries. Guessing this was the bug — a
  // 20-column underestimate let 8 hints "fit" in 100 columns, the bar wrapped,
  // and the clipped second line took `q quit` with it.
  const width = (hs: Hint[]): number =>
    hs.reduce((n, h) => n + h.key.length + 1 + h.label.length + 2, 0) +
    Math.max(0, hs.length - 1) * 3 +
    2;

  const live = [...ALL_HINTS];
  while (width(live) > columns) {
    let victim = -1;
    let worst = -1;
    live.forEach((h, i) => {
      if (h.sacrifice !== undefined && h.sacrifice >= worst) {
        worst = h.sacrifice;
        victim = i;
      }
    });
    if (victim < 0) break; // only load-bearing hints left; clipping is the floor
    live.splice(victim, 1);
  }
  return live;
}
