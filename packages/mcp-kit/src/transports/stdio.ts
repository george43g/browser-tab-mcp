/**
 * stdio transport bootstrap.
 *
 * Wires an MCP `Server` instance to `StdioServerTransport` with the
 * standard set of lifecycle handlers (shutdown, stdin EOF, orphan watch,
 * watchdog, heap monitor).
 *
 * Critical invariant after this returns: NEVER write to stdout. JSON-RPC
 * owns it. All logging must go through @george43g/robustness/logger.
 */

import {
  enableOrphanWatchdog,
  enableStdinEofDetection,
  installShutdownHandlers,
  installWatchdog,
  logStartup,
  startHeapMonitor,
} from "@george43g/robustness";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

export interface StartStdioOptions {
  server: Server;
  entrypoint: string;
}

export async function startStdio({ server, entrypoint }: StartStdioOptions): Promise<void> {
  installShutdownHandlers();
  enableStdinEofDetection();
  enableOrphanWatchdog();
  installWatchdog();
  startHeapMonitor();
  logStartup(entrypoint);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
