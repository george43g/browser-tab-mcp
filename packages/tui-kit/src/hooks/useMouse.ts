/**
 * Mouse hook — SGR protocol click + scroll events.
 *
 * Lifted from imsg-mcp/src/tui/hooks/useMouse.ts with the same critical
 * comment about ?1003h flooding the event loop.
 *
 * Enables modes:
 *   ?1000h — button-event tracking (press/release + scroll only)
 *   ?1006h — SGR extended coordinates (x/y not capped at 223)
 *
 * Explicitly does NOT enable ?1003h (any-event tracking) — that fires for
 * every pixel of mouse motion, pinning the event loop and trashing scroll
 * performance. The watchdog's event-loop monitor will eventually kill the
 * process if this is enabled by mistake.
 */

import { useStdin } from "ink";
import { useEffect } from "react";

export interface MouseEvent {
  type: "click" | "scroll-up" | "scroll-down";
  x: number;
  y: number;
  button: number;
}

export function useMouse(onEvent: (event: MouseEvent) => void) {
  const { stdin, setRawMode } = useStdin();

  useEffect(() => {
    process.stdout.write("\x1b[?1000h\x1b[?1006h");
    setRawMode(true);

    const handler = (data: Buffer) => {
      const str = data.toString();
      // SGR mouse format: \x1b[<btn;x;y;M (press) or \x1b[<btn;x;y;m (release)
      const re = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
      let match = re.exec(str);
      while (match !== null) {
        const [, btnStr, xStr, yStr, kind] = match;
        if (!btnStr || !xStr || !yStr) {
          match = re.exec(str);
          continue;
        }
        const btn = Number.parseInt(btnStr, 10);
        const x = Number.parseInt(xStr, 10);
        const y = Number.parseInt(yStr, 10);
        const isPress = kind === "M";

        if (btn === 64 && isPress) {
          onEvent({ type: "scroll-up", x, y, button: btn });
        } else if (btn === 65 && isPress) {
          onEvent({ type: "scroll-down", x, y, button: btn });
        } else if (btn === 0 && isPress) {
          onEvent({ type: "click", x, y, button: btn });
        }
        match = re.exec(str);
      }
    };

    stdin.on("data", handler);
    return () => {
      stdin.off("data", handler);
      process.stdout.write("\x1b[?1000l\x1b[?1006l");
    };
  }, [stdin, setRawMode, onEvent]);
}
