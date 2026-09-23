/**
 * B36: a long apply reported "timed out" while the daemon finished the job.
 * The IPC client's hard-coded 15s cut the tool's own 30s budget short, and the
 * timeout read as a failure when the outcome was really unknown.
 */

import { createServer, type Server } from "node:net";
import { defaultIpcEndpoint, makeTmpDir } from "@george43g/test-kit";
import { afterEach, describe, expect, it } from "vitest";
import { DaemonClient, DaemonTimeoutError } from "../src/client/daemon-client.js";
import { APPLY_TAB_LAYOUT_TIMEOUT_MS, applyTimeoutError } from "../src/client/tabs-service.js";
import { applyTabLayoutTool } from "../src/tools/apply-tab-layout.js";

let server: Server | undefined;
afterEach(() => {
  server?.close();
  server = undefined;
});

/** A daemon that accepts the connection and never answers. */
async function silentDaemon(): Promise<string> {
  // A named pipe on Windows, a socket file elsewhere (a file path is EACCES there).
  const path = defaultIpcEndpoint(makeTmpDir("silent-daemon-"));
  server = createServer(() => {});
  await new Promise<void>((resolve) => server?.listen(path, resolve));
  return path;
}

describe("daemon request timeout (B36)", () => {
  it("honours a per-request timeout instead of the fixed default", async () => {
    const client = new DaemonClient(await silentDaemon());
    const started = Date.now();
    await expect(client.request("applyTabLayout", {}, { timeoutMs: 80 })).rejects.toBeInstanceOf(
      DaemonTimeoutError,
    );
    // Control: the 15s default would blow the vitest timeout long before this.
    expect(Date.now() - started).toBeLessThan(2_000);
    client.close();
  });

  it("names the method and the budget it gave up after", async () => {
    const client = new DaemonClient(await silentDaemon());
    const err = (await client.request("applyTabLayout", {}, { timeoutMs: 60 }).then(
      () => undefined,
      (e: unknown) => e,
    )) as Error;
    expect(String(err.message)).toMatch(/"applyTabLayout" timed out after 60ms/);
    client.close();
  });

  it("apply's timeout reports the outcome as UNKNOWN and points at the journal", () => {
    const msg = applyTimeoutError(APPLY_TAB_LAYOUT_TIMEOUT_MS).message;
    expect(msg).toMatch(/may still be applying/);
    expect(msg).toMatch(/unknown, not failed/);
    expect(msg).toMatch(/browser-tab operations/);
    expect(msg).not.toMatch(/failed to apply/i);
  });

  it("the tool's budget encloses the IPC budget, so the honest error wins the race", () => {
    expect(applyTabLayoutTool.timeoutMs).toBeGreaterThan(APPLY_TAB_LAYOUT_TIMEOUT_MS);
  });
});
