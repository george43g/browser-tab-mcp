import { makeContractTab, makeTabGroup } from "@george43g/test-kit";
import { describe, expect, it } from "vitest";
import { tabBadges } from "./rows.js";

describe("tabBadges", () => {
  it("is empty for a plain, silent, ungrouped tab", () => {
    expect(tabBadges(makeContractTab(), [])).toBe("");
  });

  it("shows 📌 for a pinned tab", () => {
    expect(tabBadges(makeContractTab({ pinned: true }), [])).toBe("📌");
  });

  it("shows ⏳ only while the tab status is loading", () => {
    expect(tabBadges(makeContractTab({ status: "loading" }), [])).toBe("⏳");
    expect(tabBadges(makeContractTab({ status: "complete" }), [])).toBe("");
  });

  it("shows 🔊 for an audible tab", () => {
    expect(tabBadges(makeContractTab({ audible: true }), [])).toBe("🔊");
  });

  it("shows 🔇 for a muted tab, and mute wins over audible", () => {
    expect(tabBadges(makeContractTab({ muted: true }), [])).toBe("🔇");
    expect(tabBadges(makeContractTab({ audible: true, muted: true }), [])).toBe("🔇");
  });

  it("shows 🧊 for a frozen tab", () => {
    expect(tabBadges(makeContractTab({ frozen: true }), [])).toBe("🧊");
  });

  it("shows 💤 for a discarded (asleep) tab", () => {
    expect(tabBadges(makeContractTab({ discarded: true }), [])).toBe("💤");
  });

  it("carries the group's COLOUR, which no surface used to show", () => {
    // `color` is in the v2 contract, mapped from Chrome and writable via
    // `group_tabs --color` — and until now every renderer dropped it, so the
    // one visual property of a tab group was invisible.
    const group = makeTabGroup({ groupId: "g:chrome:x9", title: "Work", color: "blue" });
    const tab = makeContractTab({ groupId: "g:chrome:x9" });
    expect(tabBadges(tab, [group])).toBe("🔵Work");
  });

  it("gives each palette entry a distinct disc", () => {
    // Two groups that differ only by colour must not render identically —
    // that is the entire point of showing it.
    const seen = new Set<string>();
    for (const color of [
      "grey",
      "blue",
      "red",
      "yellow",
      "green",
      "pink",
      "purple",
      "cyan",
      "orange",
    ]) {
      const g = makeTabGroup({ groupId: "g:chrome:x9", title: "", color });
      seen.add(tabBadges(makeContractTab({ groupId: "g:chrome:x9" }), [g]));
    }
    expect(seen.size).toBe(9);
  });

  it("falls back to a bare ⊞ when the group or its colour is unknown", () => {
    // groupId set but no matching group in the list → still flagged as grouped.
    expect(tabBadges(makeContractTab({ groupId: "g:chrome:x9" }), [])).toBe("⊞");
    // A colour Chrome adds later must degrade, not emit a stray glyph.
    const odd = makeTabGroup({ groupId: "g:chrome:x9", title: "", color: "chartreuse" });
    expect(tabBadges(makeContractTab({ groupId: "g:chrome:x9" }), [odd])).toBe("⊞");
  });

  it("truncates a long group title to keep the row compact", () => {
    const group = makeTabGroup({
      groupId: "g:chrome:x1",
      title: "A very very long group name",
      color: "green",
    });
    expect(tabBadges(makeContractTab({ groupId: "g:chrome:x1" }), [group])).toBe(
      "🟢A very very long",
    );
  });

  it("composes every badge in a stable order (pin · load · audio · freeze · sleep · group)", () => {
    const group = makeTabGroup({ groupId: "g:chrome:x2", title: "Docs", color: "blue" });
    const tab = makeContractTab({
      pinned: true,
      status: "loading",
      muted: true,
      frozen: true,
      discarded: true,
      groupId: "g:chrome:x2",
    });
    expect(tabBadges(tab, [group])).toBe("📌 ⏳ 🔇 🧊 💤 🔵Docs");
  });
});
