/**
 * Live-move-domain derivation (ruling R3) — the §24.5 preflight input.
 * The load-bearing assertions are the negative ones: no extension, no domain;
 * mixed partitions or any unknown member ⇒ NOT uniform.
 */

import {
  makeBrowserState,
  makeContractTab,
  makeContractWindow,
  makeSnapshot,
} from "@george43g/test-kit";
import { describe, expect, it } from "vitest";
import { type BrowserRef, makeBrowserDomain } from "./browser-domain.js";
import { liveMoveDomainId, summarizeLiveMoveDomains } from "./domains.js";

const snap = makeSnapshot({
  browsers: [
    makeBrowserState({
      browser: "chrome",
      extensionConnected: true,
      dataSource: "extension",
      windows: [
        makeContractWindow({
          windowId: "w:chrome:x1",
          tabs: [makeContractTab({ tabId: "t:chrome:x10", index: 0 })],
        }),
        makeContractWindow({
          windowId: "w:chrome:x2",
          incognito: true,
          tabs: [makeContractTab({ tabId: "t:chrome:x20", index: 0 })],
        }),
      ],
    }),
    makeBrowserState({
      browser: "safari",
      extensionConnected: false,
      dataSource: "applescript",
      windows: [
        makeContractWindow({
          windowId: "w:safari:1",
          tabs: [makeContractTab({ tabId: "t:safari:w1:i1", index: 0 })],
        }),
      ],
    }),
  ],
});
const domain = makeBrowserDomain(snap);
const ref = (key: string) => domain.byKey(key) as BrowserRef;

describe("liveMoveDomainId", () => {
  it("extension-connected tabs get ext:<browser>:<partition>", () => {
    expect(liveMoveDomainId(ref("t:chrome:x10"))).toBe("ext:chrome:normal");
    expect(liveMoveDomainId(ref("t:chrome:x20"))).toBe("ext:chrome:incognito");
    expect(liveMoveDomainId(ref("w:chrome:x2"))).toBe("ext:chrome:incognito");
  });

  it("no extension ⇒ no live-move domain, whatever the browser is named", () => {
    expect(liveMoveDomainId(ref("t:safari:w1:i1"))).toBeNull();
    expect(liveMoveDomainId(ref("w:safari:1"))).toBeNull();
  });

  it("a browser node spans partitions and has no single domain", () => {
    expect(liveMoveDomainId(ref("chrome"))).toBeNull();
  });
});

describe("summarizeLiveMoveDomains", () => {
  it("uniform for a same-partition selection", () => {
    const s = summarizeLiveMoveDomains([ref("t:chrome:x10")]);
    expect(s).toEqual({ domains: ["ext:chrome:normal"], unknownCount: 0, uniform: true });
  });

  it("NOT uniform across the incognito boundary — the blocked-live-move shape", () => {
    const s = summarizeLiveMoveDomains([ref("t:chrome:x10"), ref("t:chrome:x20")]);
    expect(s.domains).toEqual(["ext:chrome:normal", "ext:chrome:incognito"]);
    expect(s.uniform).toBe(false);
  });

  it("any unknown member breaks uniformity even in one partition", () => {
    const s = summarizeLiveMoveDomains([ref("t:chrome:x10"), ref("t:safari:w1:i1")]);
    expect(s.unknownCount).toBe(1);
    expect(s.uniform).toBe(false);
  });

  it("an empty selection is not uniform (nothing to move is not a domain)", () => {
    expect(summarizeLiveMoveDomains([]).uniform).toBe(false);
  });
});
