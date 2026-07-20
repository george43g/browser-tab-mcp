/**
 * Bridge the Node `ws` package's `WebSocket` onto `globalThis.WebSocket` so
 * browser code (extension-core's `DaemonSocket`) can run under Node against a
 * real loopback server. Lives on the `./node` subpath — it pulls `ws`.
 */

import { WebSocket as NodeWebSocket } from "ws";

export function installNodeWebSocket(): { restore(): void } {
  const holder = globalThis as { WebSocket?: unknown };
  const prev = holder.WebSocket;
  holder.WebSocket = NodeWebSocket as unknown as typeof WebSocket;
  return {
    restore(): void {
      if (prev === undefined) delete holder.WebSocket;
      else holder.WebSocket = prev;
    },
  };
}
