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

  it("shows the group title (⊞-prefixed) for a grouped tab", () => {
    const group = makeTabGroup({ groupId: "g:chrome:x9", title: "Work" });
    const tab = makeContractTab({ groupId: "g:chrome:x9" });
    expect(tabBadges(tab, [group])).toBe("⊞Work");
  });

  it("falls back to a bare ⊞ when the group is untitled or unknown", () => {
    const untitled = makeTabGroup({ groupId: "g:chrome:x9", title: "" });
    expect(tabBadges(makeContractTab({ groupId: "g:chrome:x9" }), [untitled])).toBe("⊞");
    // groupId set but no matching group in the list → still flagged as grouped.
    expect(tabBadges(makeContractTab({ groupId: "g:chrome:x9" }), [])).toBe("⊞");
  });

  it("truncates a long group title to keep the row compact", () => {
    const group = makeTabGroup({ groupId: "g:chrome:x1", title: "A very very long group name" });
    expect(tabBadges(makeContractTab({ groupId: "g:chrome:x1" }), [group])).toBe(
      "⊞A very very long",
    );
  });

  it("composes every badge in a stable order (pin · load · audio · freeze · sleep · group)", () => {
    const group = makeTabGroup({ groupId: "g:chrome:x2", title: "Docs" });
    const tab = makeContractTab({
      pinned: true,
      status: "loading",
      muted: true,
      frozen: true,
      discarded: true,
      groupId: "g:chrome:x2",
    });
    expect(tabBadges(tab, [group])).toBe("📌 ⏳ 🔇 🧊 💤 ⊞Docs");
  });
});
