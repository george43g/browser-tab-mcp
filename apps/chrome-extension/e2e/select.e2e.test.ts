/**
 * `select_tabs` against a real browser — DSL Phase 2 PR-B.
 *
 * Dual-truth rule: every selection is verified against BOTH the daemon's
 * answer and `chrome.tabs.query` truth in the extension's service worker — a
 * selector agreeing with the snapshot it was resolved from is what the unit
 * tier already proves; agreeing with the BROWSER is what this tier exists for.
 *
 * Fixture trap this spec respects: the throwaway daemon's fake AppleScript
 * adapter fabricates brave/chromium/safari windows, so every selector here
 * scopes through the run browser's OWN window (members-of-ids projection),
 * never `allTabs` — a spec that scans the whole universe measures the
 * fixture, successfully.
 */

import { expect, type Stack, startStack, test } from "./fixtures.js";
import { type LocalServer, startLocalServer } from "./local-server.js";

test.describe.configure({ mode: "serial" });

test.describe("select_tabs", () => {
  let stack: Stack;
  let server: LocalServer;

  const selectCli = async (selector: unknown, projection: string): Promise<string> =>
    stack.daemon.cli([
      "select",
      "--selector",
      JSON.stringify(selector),
      "--projection",
      projection,
      "--json",
    ]);

  test.beforeAll(async () => {
    stack = await startStack(import.meta.url);
    server = await startLocalServer();
  });

  test.afterAll(async () => {
    await server?.close();
    await stack?.close();
  });

  test("predicate and signed-position selections match chrome.tabs.query truth", async () => {
    test.info().annotations.push({ type: "surface", description: "select_tabs" });

    // One fresh window, three tabs: two under /u/sel-, one bystander.
    const made = await stack.sw.evaluate(
      async (urls) => {
        const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
        const w = await c.windows.create({ url: urls[0], focused: true });
        const a = w.tabs?.[0]?.id as number;
        const b = (await c.tabs.create({ windowId: w.id as number, url: urls[1] })).id as number;
        const o = (await c.tabs.create({ windowId: w.id as number, url: urls[2] })).id as number;
        return { win: w.id as number, a, b, o };
      },
      [server.url("/u/sel-a"), server.url("/u/sel-b"), server.url("/u/other")],
    );
    await stack.waitForTab(stack.tabHandle(made.o));
    const winHandle = stack.windowHandle(made.win);
    const inWindow = {
      kind: "members",
      nodes: { kind: "ids", ids: [winHandle] },
      relation: "tabs",
    };

    // --- predicate: path prefix /u/sel- ------------------------------------
    const byPath = JSON.parse(
      await selectCli(
        {
          kind: "where",
          scope: inWindow,
          predicate: { kind: "cmp", field: "path", op: "prefix", value: "/u/sel-" },
        },
        "ids",
      ),
    ) as { count: number; ids: string[]; resolution: { snapshotToken?: string } };

    // Browser truth for the same question, straight from chrome.tabs.query.
    const truthIds = await stack.sw.evaluate(async (winId) => {
      const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      const tabs = await c.tabs.query({ windowId: winId });
      return tabs
        .filter((t) => new URL(t.url ?? "about:blank").pathname.startsWith("/u/sel-"))
        .map((t) => t.id as number);
    }, made.win);
    expect(byPath.count).toBe(2);
    expect([...byPath.ids].sort()).toEqual(truthIds.map((id) => stack.tabHandle(id)).sort());
    expect(byPath.resolution.snapshotToken).toMatch(/^[0-9a-f]{8}:\d+$/);

    // --- signed position: -1 = the window's last tab -----------------------
    const last = JSON.parse(
      await selectCli({ kind: "positions", scope: inWindow, positions: [-1] }, "core"),
    ) as {
      count: number;
      rows: Array<{ tabId: string; index: number; windowId: string }>;
      resolution: { liveMoveDomains: { uniform: boolean; domains: string[] } };
    };
    const truthLast = await stack.sw.evaluate(async (winId) => {
      const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      const tabs = await c.tabs.query({ windowId: winId });
      const max = Math.max(...tabs.map((t) => t.index));
      const t = tabs.find((x) => x.index === max);
      return { id: t?.id as number, index: max };
    }, made.win);
    expect(last.count).toBe(1);
    expect(last.rows[0]?.tabId).toBe(stack.tabHandle(truthLast.id));
    expect(last.rows[0]?.index).toBe(truthLast.index);
    expect(last.rows[0]?.windowId).toBe(winHandle);
    // One extension-connected window ⇒ exactly one live-move domain.
    expect(last.resolution.liveMoveDomains.uniform).toBe(true);
    expect(last.resolution.liveMoveDomains.domains).toHaveLength(1);

    await stack.sw.evaluate(async (winId) => {
      const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      await c.windows.remove(winId);
    }, made.win);
  });

  test("plan_tab_change plans a reverse without touching the browser", async () => {
    test.info().annotations.push({ type: "surface", description: "plan_tab_change" });

    const made = await stack.sw.evaluate(
      async (urls) => {
        const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
        const w = await c.windows.create({ url: urls[0], focused: true });
        const a = w.tabs?.[0]?.id as number;
        const b = (await c.tabs.create({ windowId: w.id as number, url: urls[1] })).id as number;
        const o = (await c.tabs.create({ windowId: w.id as number, url: urls[2] })).id as number;
        return { win: w.id as number, a, b, o };
      },
      [server.url("/u/pl-a"), server.url("/u/pl-b"), server.url("/u/pl-c")],
    );
    await stack.waitForTab(stack.tabHandle(made.o));
    const winHandle = stack.windowHandle(made.win);

    const before = await stack.sw.evaluate(async (winId) => {
      const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      const tabs = await c.tabs.query({ windowId: winId });
      return tabs.sort((x, y) => x.index - y.index).map((t) => t.id as number);
    }, made.win);

    const plan = JSON.parse(
      await stack.daemon.cli([
        "plan",
        "--selector",
        JSON.stringify({
          kind: "members",
          nodes: { kind: "ids", ids: [winHandle] },
          relation: "tabs",
        }),
        "--transform",
        JSON.stringify({ kind: "reverse" }),
        "--json",
      ]),
    ) as {
      planId: string;
      riskClass: string;
      effectCount: number;
      effects: Array<{ kind: string; tabId: string; after: string | null }>;
    };
    expect(plan.riskClass).toBe("live-layout");
    expect(plan.planId).toMatch(/^[0-9a-f]{8}$/);

    // The effects imply EXACTLY the reversed arrangement: simulate the
    // after-chain onto the browser-truth order.
    const strip = before.map((id) => stack.tabHandle(id));
    for (const e of plan.effects) {
      expect(e.kind).toBe("relocate");
      strip.splice(strip.indexOf(e.tabId), 1);
      if (e.after === null) strip.unshift(e.tabId);
      else strip.splice(strip.indexOf(e.after) + 1, 0, e.tabId);
    }
    expect(strip).toEqual([...before].reverse().map((id) => stack.tabHandle(id)));

    // Planning must not have MOVED anything — browser truth unchanged.
    const after = await stack.sw.evaluate(async (winId) => {
      const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      const tabs = await c.tabs.query({ windowId: winId });
      return tabs.sort((x, y) => x.index - y.index).map((t) => t.id as number);
    }, made.win);
    expect(after).toEqual(before);

    await stack.sw.evaluate(async (winId) => {
      const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      await c.windows.remove(winId);
    }, made.win);
  });

  test("apply_tab_layout applies a planned reverse — the browser's own order flips", async () => {
    test.info().annotations.push({ type: "surface", description: "apply_tab_layout" });

    const made = await stack.sw.evaluate(
      async (urls) => {
        const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
        const w = await c.windows.create({ url: urls[0], focused: true });
        const a = w.tabs?.[0]?.id as number;
        const b = (await c.tabs.create({ windowId: w.id as number, url: urls[1] })).id as number;
        const o = (await c.tabs.create({ windowId: w.id as number, url: urls[2] })).id as number;
        return { win: w.id as number, a, b, o };
      },
      [server.url("/u/ap-a"), server.url("/u/ap-b"), server.url("/u/ap-c")],
    );
    await stack.waitForTab(stack.tabHandle(made.o));
    const winHandle = stack.windowHandle(made.win);

    const before = await stack.sw.evaluate(async (winId) => {
      const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      const tabs = await c.tabs.query({ windowId: winId });
      return tabs.sort((x, y) => x.index - y.index).map((t) => t.id as number);
    }, made.win);

    const plan = JSON.parse(
      await stack.daemon.cli([
        "plan",
        "--selector",
        JSON.stringify({
          kind: "members",
          nodes: { kind: "ids", ids: [winHandle] },
          relation: "tabs",
        }),
        "--transform",
        JSON.stringify({ kind: "reverse" }),
        "--json",
      ]),
    ) as { planId: string };

    const applied = JSON.parse(
      await stack.daemon.cli(["apply", "--plan", plan.planId, "--json"]),
    ) as { status: string; residual: unknown[] };
    expect(applied.status).toBe("success");
    expect(applied.residual).toEqual([]);

    // BROWSER truth: the window's real order is now the reverse.
    const after = await stack.sw.evaluate(async (winId) => {
      const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      const tabs = await c.tabs.query({ windowId: winId });
      return tabs.sort((x, y) => x.index - y.index).map((t) => t.id as number);
    }, made.win);
    expect(after).toEqual([...before].reverse());

    // A second apply of the SAME plan must be refused as stale — the state
    // it was planned against is gone (its own application moved it).
    const rerun = await stack.daemon
      .cli(["apply", "--plan", plan.planId, "--json"])
      .then(() => "UNEXPECTED_SUCCESS")
      .catch(
        // exec-style errors carry the CLI's stdout (where the error envelope
        // prints) alongside message; the refusal reason lives there.
        (e: Error & { stdout?: string; stderr?: string }) =>
          `${e.message} ${e.stdout ?? ""} ${e.stderr ?? ""}`,
      );
    expect(rerun).not.toBe("UNEXPECTED_SUCCESS");
    expect(rerun).toMatch(/different snapshot|unknown or expired/);

    await stack.sw.evaluate(async (winId) => {
      const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      await c.windows.remove(winId);
    }, made.win);
  });

  test("copy_tabs reconstructs at the destination and every source survives", async () => {
    test.info().annotations.push({ type: "surface", description: "copy_tabs" });

    const made = await stack.sw.evaluate(
      async (urls) => {
        const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
        const w1 = await c.windows.create({ url: urls[0], focused: true });
        const a = w1.tabs?.[0]?.id as number;
        const b = (await c.tabs.create({ windowId: w1.id as number, url: urls[1] })).id as number;
        const w2 = await c.windows.create({ url: "about:blank", focused: false });
        return { w1: w1.id as number, w2: w2.id as number, a, b };
      },
      [server.url("/u/cp-a"), server.url("/u/cp-b")],
    );
    await stack.waitForTab(stack.tabHandle(made.b));
    const w1Handle = stack.windowHandle(made.w1);
    const w2Handle = stack.windowHandle(made.w2);

    const out = JSON.parse(
      await stack.daemon.cli([
        "copy",
        "--selector",
        JSON.stringify({
          kind: "where",
          scope: { kind: "members", nodes: { kind: "ids", ids: [w1Handle] }, relation: "tabs" },
          predicate: { kind: "cmp", field: "path", op: "prefix", value: "/u/cp-" },
        }),
        "--to-window",
        w2Handle,
        "--json",
      ]),
    ) as { status: string; items: Array<{ status: string; createdTabId?: string }> };
    expect(out.status).toBe("success");
    expect(out.items.map((i) => i.status)).toEqual(["created", "created"]);

    // BROWSER truth: sources still live in w1; copies exist in w2 with the
    // same URLs; and the copies are NEW tab identities.
    const truth = await stack.sw.evaluate(
      async (args) => {
        const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
        const w1tabs = await c.tabs.query({ windowId: args.w1 });
        const w2tabs = await c.tabs.query({ windowId: args.w2 });
        const path = (u?: string) => new URL(u ?? "about:blank").pathname;
        return {
          sourcesAlive: [args.a, args.b].every((id) => w1tabs.some((t) => t.id === id)),
          copyPaths: w2tabs
            .map((t) => path(t.url || (t as { pendingUrl?: string }).pendingUrl))
            .filter((p) => p.startsWith("/u/cp-"))
            .sort(),
          copyIds: w2tabs.map((t) => t.id as number),
        };
      },
      { w1: made.w1, w2: made.w2, a: made.a, b: made.b },
    );
    expect(truth.sourcesAlive).toBe(true);
    expect(truth.copyPaths).toEqual(["/u/cp-a", "/u/cp-b"]);
    expect(truth.copyIds).not.toContain(made.a);
    expect(truth.copyIds).not.toContain(made.b);

    await stack.sw.evaluate(
      async (args) => {
        const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
        await c.windows.remove(args.w1);
        await c.windows.remove(args.w2);
      },
      { w1: made.w1, w2: made.w2 },
    );
  });
});
