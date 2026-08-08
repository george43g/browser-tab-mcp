/**
 * Live terminal dimensions.
 *
 * Ink re-renders on resize but does NOT tell a component how many rows it has,
 * so anything that slices its own scroll window has to ask stdout directly and
 * re-read on SIGWINCH. Without this the list height is a compile-time guess:
 * too small wastes most of a tall terminal, too large overflows the flex
 * container and overprints the status/help bars.
 *
 * Lives in the app rather than tui-kit because the kit packages are published
 * from mcp-cli-starter-template and frozen here; an eventual `useTerminalSize`
 * export upstream can replace this (see docs/agent-handoff/UPSTREAM-KIT-BRIEF.md).
 */

import { useStdout } from "ink";
import { useEffect, useState } from "react";

export interface TerminalSize {
  rows: number;
  columns: number;
}

/** Conservative fallback when stdout reports nothing (piped, or a stub in tests). */
const FALLBACK: TerminalSize = { rows: 24, columns: 80 };

function read(stdout: NodeJS.WriteStream | undefined): TerminalSize {
  return {
    rows: stdout?.rows && stdout.rows > 0 ? stdout.rows : FALLBACK.rows,
    columns: stdout?.columns && stdout.columns > 0 ? stdout.columns : FALLBACK.columns,
  };
}

export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TerminalSize>(() => read(stdout));

  useEffect(() => {
    if (!stdout) return;
    const onResize = () => setSize(read(stdout));
    // Re-read once on mount: fullscreen-ink switches to the alternate screen
    // after the first paint, which can change the reported row count.
    onResize();
    stdout.on("resize", onResize);
    return () => {
      stdout.off("resize", onResize);
    };
  }, [stdout]);

  return size;
}
