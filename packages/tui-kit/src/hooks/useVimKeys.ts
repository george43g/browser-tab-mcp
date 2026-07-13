/**
 * Vim-style key parser hook.
 *
 * Generalizes imsg-mcp's App.tsx number-buffer + gg double-press pattern
 * into a reusable hook. Caller provides handlers for the standard motion
 * keys; the hook tracks the number-prefix buffer and the gg timer.
 *
 * Behavior:
 *   - Digits accumulate a count buffer (max 9999).
 *   - `getCount()` returns the buffer and resets it (or 1 if empty).
 *   - `gg` (two presses within 500ms) triggers `onTop`.
 *   - `G` triggers `onBottom`.
 *   - `j`/`k` (or arrow down/up) call `onMove(count)`.
 *   - Ctrl-D / Ctrl-U call `onHalfPageDown` / `onHalfPageUp`.
 *
 * Mode-aware: pass `enabled: false` to suspend handling (e.g. while a modal
 * is open). The hook still runs but no-ops.
 */

import { useInput } from "ink";
import { useCallback, useRef } from "react";

export interface VimKeysHandlers {
  onMove?(delta: number): void;
  onTop?(): void;
  onBottom?(): void;
  onHalfPageDown?(): void;
  onHalfPageUp?(): void;
  /** Forward unhandled keys (single character or named) to the host. */
  onUnhandled?(input: string, key: KeyState): void;
}

export interface KeyState {
  ctrl?: boolean;
  shift?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
}

export interface UseVimKeysOptions extends VimKeysHandlers {
  enabled?: boolean;
  /** ms within which a second `g` triggers gg. Default 500. */
  ggTimeoutMs?: number;
}

const MAX_COUNT = 9999;

export function useVimKeys(opts: UseVimKeysOptions) {
  const numBufferRef = useRef("");
  const ggPendingRef = useRef(false);
  const ggTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enabled = opts.enabled !== false;
  const ggTimeout = opts.ggTimeoutMs ?? 500;

  const getCount = useCallback((): number => {
    const raw = numBufferRef.current;
    numBufferRef.current = "";
    if (!raw) return 1;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? Math.min(n, MAX_COUNT) : 1;
  }, []);

  useInput((input, key) => {
    if (!enabled) return;

    // Digit accumulation
    if (input >= "0" && input <= "9" && !key.ctrl) {
      // Avoid bumping `0` as a count starter when buffer is empty (vim convention).
      if (numBufferRef.current === "" && input === "0") return;
      numBufferRef.current = (numBufferRef.current + input).slice(0, 4);
      return;
    }

    // gg double-press → onTop
    if (input === "g" && !key.ctrl && !key.shift) {
      if (ggPendingRef.current) {
        ggPendingRef.current = false;
        if (ggTimerRef.current) clearTimeout(ggTimerRef.current);
        ggTimerRef.current = null;
        opts.onTop?.();
        numBufferRef.current = "";
        return;
      }
      ggPendingRef.current = true;
      ggTimerRef.current = setTimeout(() => {
        ggPendingRef.current = false;
      }, ggTimeout);
      ggTimerRef.current.unref?.();
      return;
    }

    // G → onBottom
    if (input === "G" || (input === "g" && key.shift)) {
      opts.onBottom?.();
      return;
    }

    // Ctrl-D / Ctrl-U
    if (key.ctrl && input === "d") {
      opts.onHalfPageDown?.();
      return;
    }
    if (key.ctrl && input === "u") {
      opts.onHalfPageUp?.();
      return;
    }

    // j / k or arrows
    if (input === "j" || key.downArrow) {
      opts.onMove?.(getCount());
      return;
    }
    if (input === "k" || key.upArrow) {
      opts.onMove?.(-getCount());
      return;
    }

    opts.onUnhandled?.(input, key);
  });

  return { getCount };
}
