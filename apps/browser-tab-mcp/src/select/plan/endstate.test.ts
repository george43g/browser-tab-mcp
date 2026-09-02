/**
 * planEndState — §11 semantics as code: leading-run partial layouts,
 * §11.2 transport policy (auto NEVER resolves to cut), strict coverage,
 * risk decomposition into live effects + prepared copy/cut requests, and
 * the §24.6 pinned refusal.
 */
import {
  makeBrowserState,
  makeContractTab,
  makeContractWindow,
  makeSnapshot,
} from "@george43g/test-kit";
import { describe, expect, it } from "vitest";
import { makeBrowserDomain } from "../browser-domain.js";
import { planEndState } from "./endstate.js";
import { PlanError } from "./planner.js";

function world() {
  const snapshot = makeSnapshot({
    browsers: [
      makeBrowserState({
        browser: "chrome",
        extensionConnected: true,
        dataSource: "extension",
        windows: [
          makeContractWindow({
            windowId: "w1",
            focused: true,
            tabs: ["a", "b", "c"].map((tabId, index) => makeContractTab({ tabId, index })),
          }),
          makeContractWindow({
            windowId: "w2",
            tabs: ["d", "e"].map((tabId, index) => makeContractTab({ tabId, index })),
          }),
        ],
      }),
      makeBrowserState({
        browser: "safari",
        extensionConnected: true,
        dataSource: "extension",
        windows: [
          makeContractWindow({
            windowId: "s1",
            tabs: ["x", "y"].map((tabId, index) => makeContractTab({ tabId, index })),
          }),
        ],
      }),
    ],
  });
  return { snapshot, domain: makeBrowserDomain(snapshot) };
}

describe("planEndState", () => {
  it("compiles a same-domain two-window layout to live relocations only", () => {
    const { snapshot, domain } = world();
    const plan = planEndState(
      {
        windows: [
          { windowId: "w1", tabs: ["c", "a"] },
          { windowId: "w2", tabs: ["d", "b"] },
        ],
      },
      snapshot,
      domain,
    );
    expect(plan.additive).toEqual([]);
    expect(plan.destructive).toEqual([]);
    expect(plan.counts.copy + plan.counts.cut).toBe(0);
    expect(plan.effects.length).toBeGreaterThan(0);
    for (const e of plan.effects) expect(e.kind).toBe("relocate");
    // b is declared into w2 as a live move, so it leaves w1's tree.
    const w1Effects = plan.effects.filter(
      (e) => e.kind === "relocate" && e.targetWindowId === "w1",
    );
    expect(w1Effects.length).toBeGreaterThan(0);
  });

  it("emits nothing but a no-op warning when the layout already holds", () => {
    const { snapshot, domain } = world();
    const plan = planEndState(
      { windows: [{ windowId: "w1", tabs: ["a", "b", "c"] }] },
      snapshot,
      domain,
    );
    expect(plan.effects).toEqual([]);
    expect(plan.warnings.join(" ")).toMatch(/no-op/);
  });

  it("refuses a cross-domain arrival with no transport, naming both domains", () => {
    const { snapshot, domain } = world();
    try {
      planEndState({ windows: [{ windowId: "w1", tabs: ["a", "x"] }] }, snapshot, domain);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PlanError);
      expect((err as PlanError).code).toBe("cross_domain_live_move");
      expect((err as Error).message).toMatch(/ext:safari:normal/);
      expect((err as Error).message).toMatch(/never cut/);
    }
  });

  it('resolves transport "auto" to copy across a boundary — never cut', () => {
    const { snapshot, domain } = world();
    const plan = planEndState(
      { windows: [{ windowId: "w1", tabs: ["a", { tabId: "x", transport: "auto" }] }] },
      snapshot,
      domain,
    );
    expect(plan.counts).toMatchObject({ copy: 1, cut: 0 });
    expect(plan.additive).toEqual([
      {
        tool: "copy_tabs",
        params: {
          selector: { kind: "ids", ids: ["x"] },
          destination: { kind: "window", windowId: "w1" },
        },
      },
    ]);
  });

  it('prepares a cut_tabs request for transport "cut", warning about confirmDestruction', () => {
    const { snapshot, domain } = world();
    const plan = planEndState(
      { windows: [{ windowId: "w1", tabs: ["a", { tabId: "y", transport: "cut" }] }] },
      snapshot,
      domain,
    );
    expect(plan.destructive[0]?.tool).toBe("cut_tabs");
    expect(plan.destructive[0]?.params).not.toHaveProperty("confirmDestruction");
    expect(plan.warnings.join(" ")).toMatch(/confirmDestruction/);
    // The cut SOURCE stays in safari's tree as far as the live plan goes —
    // closing it is cut_tabs' own verified business.
    expect(plan.effects.every((e) => e.kind === "relocate")).toBe(true);
  });

  it("strict refuses a window still holding unlisted tabs; passes when covered", () => {
    const { snapshot, domain } = world();
    expect(() =>
      planEndState(
        { strict: true, windows: [{ windowId: "w1", tabs: ["a", "b"] }] },
        snapshot,
        domain,
      ),
    ).toThrow(/still holds unlisted tab/);
    const plan = planEndState(
      { strict: true, windows: [{ windowId: "w1", tabs: ["c", "b", "a"] }] },
      snapshot,
      domain,
    );
    expect(plan.effects.length).toBeGreaterThan(0);
  });

  it("validates identities: unknown window, unknown tab, duplicate placement", () => {
    const { snapshot, domain } = world();
    expect(() =>
      planEndState({ windows: [{ windowId: "nope", tabs: ["a"] }] }, snapshot, domain),
    ).toThrow(/not in the snapshot/);
    expect(() =>
      planEndState({ windows: [{ windowId: "w1", tabs: ["ghost"] }] }, snapshot, domain),
    ).toThrow(/not in the snapshot/);
    expect(() =>
      planEndState(
        {
          windows: [
            { windowId: "w1", tabs: ["a"] },
            { windowId: "w2", tabs: ["a"] },
          ],
        },
        snapshot,
        domain,
      ),
    ).toThrow(/one identity holds one place/);
  });

  it("refuses to move a pinned tab, but accepts one already in its declared slot", () => {
    const snapshot = makeSnapshot({
      browsers: [
        makeBrowserState({
          browser: "chrome",
          extensionConnected: true,
          dataSource: "extension",
          windows: [
            makeContractWindow({
              windowId: "w1",
              tabs: [
                makeContractTab({ tabId: "p", index: 0, pinned: true }),
                makeContractTab({ tabId: "q", index: 1 }),
                makeContractTab({ tabId: "r", index: 2 }),
              ],
            }),
          ],
        }),
      ],
    });
    const domain = makeBrowserDomain(snapshot);
    expect(() =>
      planEndState({ windows: [{ windowId: "w1", tabs: ["q", "p"] }] }, snapshot, domain),
    ).toThrow(/pinned/);
    const ok = planEndState(
      { windows: [{ windowId: "w1", tabs: ["p", "r", "q"] }] },
      snapshot,
      domain,
    );
    expect(ok.effects.length).toBeGreaterThan(0);
  });

  it("keeps within-window relocations LIS-minimal (unmoved run stays unmoved)", () => {
    const { snapshot, domain } = world();
    // a b c → a c b: one relocate suffices; a's position must not be touched.
    const plan = planEndState(
      { windows: [{ windowId: "w1", tabs: ["a", "c", "b"] }] },
      snapshot,
      domain,
    );
    expect(plan.effects).toHaveLength(1);
    expect(plan.effects[0]).toMatchObject({ kind: "relocate", tabId: expect.any(String) });
  });
});
