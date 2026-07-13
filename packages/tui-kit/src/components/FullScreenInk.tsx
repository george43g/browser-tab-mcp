/**
 * fullscreen-ink wrapper integrated with the shutdown registry.
 *
 * Use this instead of fullscreen-ink directly so the screen unmount
 * happens during graceful shutdown (signal, EOF, orphan reparent).
 *
 * Note: `fullscreen-ink` API has changed across versions; this wrapper
 * isolates that surface so consumers don't have to track it.
 */

import { registerCleanup, unregisterCleanup } from "@george43g/robustness";
import type { ReactNode } from "react";

export interface FullScreenInkProps {
  children: ReactNode;
}

export interface FullScreenHandle {
  /** Manually unmount the screen and stop tracking it for shutdown cleanup. */
  unmount: () => void;
  /** Resolves when the user exits Ink (Ctrl-C, q handler, etc). */
  waitUntilExit: () => Promise<void>;
}

/**
 * Render `children` in a fullscreen Ink screen with shutdown-registry
 * integration: the screen unmounts during graceful shutdown.
 *
 * Lazy-imports `fullscreen-ink` so consumers that strip the TUI surface
 * entirely don't pull it (or its `ink` peer dep) into their bundle.
 *
 * The fullscreen-ink API surface:
 *   withFullScreen(tree) -> { instance, start, waitUntilExit }
 */
export async function renderFullScreen(children: ReactNode): Promise<FullScreenHandle> {
  const { withFullScreen } = await import("fullscreen-ink");
  const screen = withFullScreen(children);
  await screen.start();

  const cleanup = () => {
    try {
      screen.instance.unmount();
    } catch {
      // best-effort
    }
  };
  registerCleanup(cleanup);

  return {
    unmount: () => {
      unregisterCleanup(cleanup);
      cleanup();
    },
    waitUntilExit: () => screen.waitUntilExit(),
  };
}
