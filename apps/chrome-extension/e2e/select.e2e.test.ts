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

  test("act mutes a whole selection — chrome.tabs.query's own mutedInfo agrees", async () => {
    test.info().annotations.push({ type: "surface", description: "plan_tab_change" });
    test.info().annotations.push({ type: "surface", description: "apply_tab_layout" });

    const made = await stack.sw.evaluate(
      async (urls) => {
        const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
        const w = await c.windows.create({ url: urls[0], focused: true });
        const a = w.tabs?.[0]?.id as number;
        const b = (await c.tabs.create({ windowId: w.id as number, url: urls[1] })).id as number;
        return { win: w.id as number, a, b };
      },
      [server.url("/u/act-a"), server.url("/u/act-b")],
    );
    await stack.waitForTab(stack.tabHandle(made.b));
    const winHandle = stack.windowHandle(made.win);
    const members = {
      kind: "members",
      nodes: { kind: "ids", ids: [winHandle] },
      relation: "tabs",
    };

    // Nothing is muted before — otherwise the assertion after would pass on a
    // fixture rather than on the effect.
    const before = await stack.sw.evaluate(async (winId) => {
      const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      return (await c.tabs.query({ windowId: winId })).map((t) => t.mutedInfo?.muted === true);
    }, made.win);
    expect(before.some((m) => m)).toBe(false);

    const plan = JSON.parse(
      await stack.daemon.cli([
        "plan",
        "--selector",
        JSON.stringify(members),
        "--transform",
        JSON.stringify({ kind: "act", action: "mute" }),
        "--json",
      ]),
    ) as { planId: string; riskClass: string };
    expect(plan.riskClass).toBe("live-layout");

    const applied = JSON.parse(
      await stack.daemon.cli(["apply", "--plan", plan.planId, "--json"]),
    ) as { status: string };
    expect(applied.status).toBe("success");

    // BROWSER truth.
    const after = await stack.sw.evaluate(async (winId) => {
      const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      return (await c.tabs.query({ windowId: winId })).map((t) => t.mutedInfo?.muted === true);
    }, made.win);
    expect(after.length).toBeGreaterThan(1);
    expect(after.every((m) => m)).toBe(true);

    await stack.sw.evaluate(async (winId) => {
      const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      await c.windows.remove(winId);
    }, made.win);
  });

  test("act group puts the whole selection in ONE real tab group", async () => {
    test.info().annotations.push({ type: "surface", description: "apply_tab_layout" });

    const made = await stack.sw.evaluate(
      async (urls) => {
        const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
        const w = await c.windows.create({ url: urls[0], focused: true });
        const b = (await c.tabs.create({ windowId: w.id as number, url: urls[1] })).id as number;
        return { win: w.id as number, b };
      },
      [server.url("/u/grp-a"), server.url("/u/grp-b")],
    );
    await stack.waitForTab(stack.tabHandle(made.b));
    const winHandle = stack.windowHandle(made.win);

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
        JSON.stringify({ kind: "act", action: "group" }),
        "--json",
      ]),
    ) as { planId: string };
    const applied = JSON.parse(
      await stack.daemon.cli(["apply", "--plan", plan.planId, "--json"]),
    ) as { status: string };
    expect(applied.status).toBe("success");

    // One group, not one per tab — the batch-verb contract, against the
    // browser's own groupId rather than our echo of it.
    const groups = await stack.sw.evaluate(async (winId) => {
      const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      return (await c.tabs.query({ windowId: winId })).map((t) => t.groupId as number);
    }, made.win);
    expect(groups.length).toBeGreaterThan(1);
    expect(new Set(groups).size).toBe(1);
    expect(groups[0]).not.toBe(-1);

    await stack.sw.evaluate(async (winId) => {
      const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      await c.windows.remove(winId);
    }, made.win);
  });

  test("a state-losing act verb comes back destructive and apply refuses it", async () => {
    test.info().annotations.push({ type: "surface", description: "plan_tab_change" });

    const made = await stack.sw.evaluate(async (url) => {
      const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
      const w = await c.windows.create({ url, focused: true });
      return { win: w.id as number, a: w.tabs?.[0]?.id as number };
    }, server.url("/u/dsc-a"));
    await stack.waitForTab(stack.tabHandle(made.a));
    const winHandle = stack.windowHandle(made.win);

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
        JSON.stringify({ kind: "act", action: "discard" }),
        "--json",
      ]),
    ) as { planId: string; riskClass: string };
    // discard throws away in-page state, so it must NOT reach the tool that
    // asks for no confirmation — the verb-aware risk table is the gate.
    expect(plan.riskClass).toBe("destructive");

    const refused = await stack.daemon
      .cli(["apply", "--plan", plan.planId, "--json"])
      .then(() => "UNEXPECTED_SUCCESS")
      .catch(
        (e: Error & { stdout?: string; stderr?: string }) =>
          `${e.message} ${e.stdout ?? ""} ${e.stderr ?? ""}`,
      );
    expect(refused).not.toBe("UNEXPECTED_SUCCESS");
    expect(refused).toMatch(/only live-layout/);

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

  test("cut_tabs transfers and CLOSES sources only after replacements verify", async () => {
    test.info().annotations.push({ type: "surface", description: "cut_tabs" });

    const made = await stack.sw.evaluate(
      async (urls) => {
        const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
        const w1 = await c.windows.create({ url: urls[0], focused: true });
        const a = w1.tabs?.[0]?.id as number;
        const b = (await c.tabs.create({ windowId: w1.id as number, url: urls[1] })).id as number;
        const keep = (await c.tabs.create({ windowId: w1.id as number, url: "about:blank" }))
          .id as number;
        const w2 = await c.windows.create({ url: "about:blank", focused: false });
        return { w1: w1.id as number, w2: w2.id as number, a, b, keep };
      },
      [server.url("/u/ct-a"), server.url("/u/ct-b")],
    );
    await stack.waitForTab(stack.tabHandle(made.keep));
    const w1Handle = stack.windowHandle(made.w1);
    const w2Handle = stack.windowHandle(made.w2);

    const out = JSON.parse(
      await stack.daemon.cli([
        "cut",
        "--selector",
        JSON.stringify({
          kind: "where",
          scope: { kind: "members", nodes: { kind: "ids", ids: [w1Handle] }, relation: "tabs" },
          predicate: { kind: "cmp", field: "path", op: "prefix", value: "/u/ct-" },
        }),
        "--to-window",
        w2Handle,
        "--confirm-destruction",
        "--json",
      ]),
    ) as { status: string; items: Array<{ status: string }> };
    expect(out.status).toBe("success");
    expect(out.items.map((i) => i.status)).toEqual(["transferred", "transferred"]);

    // BROWSER truth: sources GONE from w1 (bystander survives), replacements
    // live in w2 with the source URLs under new identities.
    const truth = await stack.sw.evaluate(
      async (args) => {
        const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
        const w1tabs = await c.tabs.query({ windowId: args.w1 });
        const w2tabs = await c.tabs.query({ windowId: args.w2 });
        const path = (u?: string) => new URL(u ?? "about:blank").pathname;
        return {
          sourcesGone: ![args.a, args.b].some((id) => w1tabs.some((t) => t.id === id)),
          bystanderAlive: w1tabs.some((t) => t.id === args.keep),
          transferPaths: w2tabs
            .map((t) => path(t.url || (t as { pendingUrl?: string }).pendingUrl))
            .filter((p) => p.startsWith("/u/ct-"))
            .sort(),
        };
      },
      { w1: made.w1, w2: made.w2, a: made.a, b: made.b, keep: made.keep },
    );
    expect(truth.sourcesGone).toBe(true);
    expect(truth.bystanderAlive).toBe(true);
    expect(truth.transferPaths).toEqual(["/u/ct-a", "/u/ct-b"]);

    await stack.sw.evaluate(
      async (args) => {
        const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
        await c.windows.remove(args.w1);
        await c.windows.remove(args.w2);
      },
      { w1: made.w1, w2: made.w2 },
    );
  });

  test("endState declares a two-window layout; apply makes the browser's own truth match", async () => {
    test.info().annotations.push({ type: "surface", description: "plan_tab_change" });
    test.info().annotations.push({ type: "surface", description: "apply_tab_layout" });

    // Two fresh windows: w1 [a, b] and w2 [c, d].
    const made = await stack.sw.evaluate(
      async (urls) => {
        const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
        const w1 = await c.windows.create({ url: urls[0], focused: true });
        const a = w1.tabs?.[0]?.id as number;
        const b = (await c.tabs.create({ windowId: w1.id as number, url: urls[1] })).id as number;
        const w2 = await c.windows.create({ url: urls[2], focused: false });
        const cc = w2.tabs?.[0]?.id as number;
        const d = (await c.tabs.create({ windowId: w2.id as number, url: urls[3] })).id as number;
        return { w1: w1.id as number, w2: w2.id as number, a, b, c: cc, d };
      },
      [server.url("/u/es-a"), server.url("/u/es-b"), server.url("/u/es-c"), server.url("/u/es-d")],
    );
    await stack.waitForTab(stack.tabHandle(made.d));

    // Declare: w1's leading run is [b, c] (c pulled across live), w2's is [d].
    // Partial semantics ⇒ final w1 = [b, c, a], final w2 = [d].
    const planned = JSON.parse(
      await stack.daemon.cli([
        "plan",
        "--end-state",
        JSON.stringify({
          windows: [
            {
              windowId: stack.windowHandle(made.w1),
              tabs: [stack.tabHandle(made.b), stack.tabHandle(made.c)],
            },
            { windowId: stack.windowHandle(made.w2), tabs: [stack.tabHandle(made.d)] },
          ],
        }),
        "--json",
      ]),
    ) as {
      planId: string;
      riskClass: string;
      endState?: { counts: { live: number; copy: number; cut: number } };
    };
    expect(planned.riskClass).toBe("live-layout");
    expect(planned.endState?.counts).toMatchObject({ copy: 0, cut: 0 });

    const applied = JSON.parse(
      await stack.daemon.cli(["apply", "--plan", planned.planId, "--json"]),
    ) as { status: string; residual: unknown[] };
    expect(applied.status).toBe("success");
    expect(applied.residual).toEqual([]);

    // BROWSER truth, both windows: the declared layout, exactly.
    const truth = await stack.sw.evaluate(
      async (args) => {
        const c = (globalThis as unknown as { chrome: typeof chrome }).chrome;
        const order = async (winId: number) =>
          (await c.tabs.query({ windowId: winId }))
            .sort((x, y) => x.index - y.index)
            .map((t) => t.id as number);
        return { w1: await order(args.w1), w2: await order(args.w2) };
      },
      { w1: made.w1, w2: made.w2 },
    );
    expect(truth.w1).toEqual([made.b, made.c, made.a]);
    expect(truth.w2).toEqual([made.d]);

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
