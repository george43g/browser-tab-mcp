/**
 * Subscription supervision: a daemon that goes away MID-SESSION must be
 * noticed.
 *
 * Previously `DaemonClient.subscribe` registered no close/error handler and
 * `useSnapshot` only fell back to polling if the FIRST subscribe threw — so a
 * daemon restart left the TUI frozen on stale data while still captioning
 * itself "daemon stream". PR-D's live smoke confirmed the *extension*
 * reconnects in <2s; nobody had checked the client.
 *
 * Real daemon, real unix socket, no mocks.
 */

import { rmSync } from "node:fs";
import { makeTmpDir, withDaemonEnv } from "@george43g/test-kit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DaemonClient } from "../src/client/daemon-client.js";
import { type DaemonHandle, startDaemon } from "../src/daemon/index.js";

let tmp: string;
let daemon: DaemonHandle | null = null;
let env: { restore(): void } | null = null;

beforeEach(() => {
  tmp = makeTmpDir("browser-tab-reconnect-");
  env = withDaemonEnv(tmp, { browsers: "chrome" });
});

afterEach(async () => {
  await daemon?.stop();
  daemon = null;
  env?.restore();
  env = null;
  rmSync(tmp, { recursive: true, force: true });
});

async function start(): Promise<DaemonHandle> {
  daemon = await startDaemon();
  await daemon.loop.refresh();
  return daemon;
}

/** Resolve once `cb` is invoked, or reject after `ms`. */
function waitFor(register: (cb: () => void) => void, ms = 3_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    register(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

describe("daemon subscription supervision", () => {
  it("notifies subscribers when the daemon goes away mid-session", async () => {
    await start();
    const client = new DaemonClient();
    await client.subscribe(() => {});

    const dropped = waitFor((cb) => client.onClose(cb));
    await daemon?.stop();
    daemon = null;

    await expect(dropped, "onClose must fire when the socket drops").resolves.toBeUndefined();
    client.close();
  });

  it("does NOT report a drop when the caller closes intentionally", async () => {
    await start();
    const client = new DaemonClient();
    await client.subscribe(() => {});

    let dropped = false;
    client.onClose(() => {
      dropped = true;
    });
    client.close();
    await new Promise((r) => setTimeout(r, 100));

    expect(dropped, "an intentional close must not look like a daemon failure").toBe(false);
  });

  it("can re-subscribe after the daemon comes back", async () => {
    await start();
    const first = new DaemonClient();
    await first.subscribe(() => {});
    const dropped = waitFor((cb) => first.onClose(cb));
    await daemon?.stop();
    daemon = null;
    await dropped;
    first.close();

    // Same socket path, fresh daemon — a new client must connect cleanly.
    await start();
    const second = new DaemonClient();
    await expect(second.subscribe(() => {})).resolves.toBeTypeOf("function");
    second.close();
  });
});
