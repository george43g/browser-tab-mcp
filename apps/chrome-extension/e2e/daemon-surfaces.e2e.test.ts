/**
 * The surfaces that describe the SYSTEM rather than the browser:
 * `health_check`, `daemon_status`, `get_logs`, `noop`.
 *
 * These look like the least interesting rows in the ledger and are not.
 * `daemon_status`'s own tool handler is invoked by NOTHING today — no
 * integration test, no stress case; only the IPC method beneath it is tested.
 * `get_logs` has only its dev-mode GATING tested, never retrieval. `noop` has
 * no CLI-level coverage at all. And every one of them is supposed to be able
 * to answer while a real browser session is live, which is the one condition
 * no existing test puts them in.
 *
 * `health_check` is the canary that must answer instantly even when the
 * network is down, so what is asserted here is that a live extension session
 * changes nothing about it.
 */

import { EXPECTED_BROWSER, expect, type Stack, startStack, test } from "./fixtures.js";

test.describe.configure({ mode: "serial" });

test.describe("daemon-facing surfaces", () => {
  let stack: Stack;

  test.beforeAll(async () => {
    stack = await startStack(import.meta.url);
  });

  test.afterAll(async () => {
    await stack?.close();
  });

  test("health_check answers while a real browser session is live", async () => {
    test.info().annotations.push({ type: "surface", description: "health_check" });
    const out = await stack.daemon.cli(["health", "--json"]);
    const parsed = JSON.parse(out) as Record<string, unknown>;
    expect(JSON.stringify(parsed).toLowerCase(), "the canary reports healthy").toContain("healthy");
  });

  test("daemon_status reports the live extension session it is actually serving", async () => {
    test.info().annotations.push({ type: "surface", description: "daemon_status" });
    // The tool handler itself is invoked by nothing today. Here it answers
    // with a real session behind it, so every field is checkable against
    // something rather than against the absence of anything.
    const s = (await stack.daemon.status()) as Record<string, unknown>;

    expect(s.reachable ?? true).toBeTruthy();
    expect(s.pid, "the daemon we spawned").toBe(stack.daemon.proc.pid);
    expect(s.wsPort, "a bound WS port — null would mean the bind was swallowed").toBe(
      stack.daemon.wsPort,
    );
    expect(s.extensions, "the live browser is listed as connected").toContain(EXPECTED_BROWSER);

    const info = (s.extensionInfo ?? []) as Array<Record<string, unknown>>;
    const session = info.find((x) => x.browser === EXPECTED_BROWSER);
    expect(session, "and has a session record").toBeTruthy();
    expect(session?.stale, "built from this tree, not a leftover dist/").toBe(false);

    const browsers = (s.browsers ?? []) as Array<Record<string, unknown>>;
    const live = browsers.find((b) => b.browser === EXPECTED_BROWSER);
    expect(live?.extensionConnected).toBe(true);
    expect(live?.dataSource).toBe("extension");
    expect(
      Number(live?.tabCount ?? -1),
      "and it is counting real tabs, not reporting an empty browser",
    ).toBeGreaterThan(0);
  });

  test("get_logs is hidden without MCP_DEV and returns real lines with it", async () => {
    test.info().annotations.push({ type: "surface", description: "get_logs" });
    // Half one — the gating — is already covered elsewhere; re-asserted here
    // because the other half depends on it being on.
    await expect(stack.daemon.cli(["logs", "--json"])).rejects.toThrow();

    // Half two is what nothing tests today: populate the log and read a line
    // back out. `--source file` is the source that can answer from a one-shot
    // CLI, and it reads THIS run's isolated MCP_LOG_DIR, not the developer's.
    const out = await stack.daemon.cli(["logs", "--source", "file", "--tail", "50", "--json"], {
      MCP_DEV: "1",
    });
    const parsed = JSON.parse(out) as { source: string; lines: string[] };
    expect(parsed.source).toBe("file");
    expect(parsed.lines.length, "the NDJSON on disk has records in it").toBeGreaterThan(0);
    const record = JSON.parse(parsed.lines[parsed.lines.length - 1] as string) as Record<
      string,
      unknown
    >;
    expect(
      record.level,
      "and they are this process's own structured records, not an opaque blob",
    ).toBeTruthy();
    expect(record.ts).toBeTruthy();
  });

  test("get_logs --source memory is EMPTY from a one-shot CLI, and that is the default", async () => {
    test.info().annotations.push({ type: "surface", description: "get_logs:memory" });
    // Pinned because it surprises. The ring buffer belongs to the CALLING
    // PROCESS, and a CLI one-shot has barely started when it reads its own
    // buffer — so the DEFAULT source returns `lines: []` for the most common
    // invocation, while the daemon's actual history sits in `file`. Recorded
    // as BACKLOG B13; asserted here so that if the default is ever changed,
    // this test says so rather than silently agreeing.
    const out = await stack.daemon.cli(["logs", "--source", "memory", "--tail", "50", "--json"], {
      MCP_DEV: "1",
    });
    const parsed = JSON.parse(out) as { source: string; lines: string[] };
    expect(parsed.source).toBe("memory");
    expect(parsed.lines, "a fresh CLI process has nothing in its own ring buffer").toEqual([]);
  });

  test("noop round-trips through the real dispatcher", async () => {
    test.info().annotations.push({ type: "surface", description: "noop" });
    // The control. If `noop` ever fails here, the finding is about the harness
    // and not about any surface above it — which is exactly what a control is
    // for. It also happens to be the only CLI-level coverage `noop` has.
    const out = JSON.parse(
      await stack.daemon.cli(["noop", "--input", "hello-e2e", "--json"]),
    ) as Record<string, unknown>;
    expect(out.echo, "the input travels the dispatcher and comes back").toBe("hello-e2e");
    // `engine` is the native-vs-TS path the whole rust-accel arrangement
    // exists for, and this is the only place it is observed through the CLI.
    expect(["rust", "ts"], `unexpected engine ${String(out.echo)}`).toContain(String(out.engine));
  });

  test("the daemon answering us is the one this spec spawned", async () => {
    test.info().annotations.push({ type: "surface", description: "daemon_status:identity" });
    // `startStack` already asserts this before any test runs — it is re-asserted
    // HERE as a named test so the guarantee is visible in the report rather than
    // buried in a fixture, and so a regression names itself.
    //
    // CI structurally cannot catch the failure it guards: a fresh runner has no
    // pre-existing daemon to be confused with. It exists for a developer's box,
    // where a real console or launchd daemon runs as the same user. Measured on
    // the Windows box 2026-08-22: a different pid, ws 8790, uptime 50 minutes,
    // and a failure that looked like a product bug.
    const s = (await stack.daemon.status()) as Record<string, unknown>;
    expect(s.pid).toBe(stack.daemon.proc.pid);
    expect(s.socket).toBe(stack.daemon.env.BROWSER_TAB_SOCKET_PATH);
    expect(Number(s.uptimeS ?? 0), "seconds old, not a long-running instance").toBeLessThan(600);
  });
});
