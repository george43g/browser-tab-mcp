/**
 * The act-verb risk table is a SAFETY boundary, so it gets a second copy.
 *
 * `apply_tab_layout` accepts only riskClass "live-layout" and asks for no
 * confirmation. So a verb that lands in ACT_VERB_RISK as live-layout is
 * reachable through a tool with no confirmation step, and a verb added
 * without a considered entry would inherit that door by default. The
 * expectation below is written out by hand ON PURPOSE: adding a verb turns
 * this file red until someone states, in a second place, what it costs.
 */
import { describe, expect, it } from "vitest";
import { ACT_VERB_RISK, type ActVerb, classifyRisk, type Effect } from "./effects.js";

/** The hand-written second copy. Update deliberately, never by copy-paste. */
const EXPECTED: Record<ActVerb, "live-layout" | "destructive"> = {
  pin: "live-layout",
  unpin: "live-layout",
  mute: "live-layout",
  unmute: "live-layout",
  group: "live-layout",
  ungroup: "live-layout",
  // Both throw away in-page state nothing can reconstruct — the reason
  // tab_action carries destructiveHint: true.
  discard: "destructive",
  reload: "destructive",
};

const act = (action: ActVerb): Effect => ({ kind: "act", tabId: "t:chrome:x1", action });

describe("act verb risk", () => {
  it("every verb has a considered entry, and the two copies agree", () => {
    expect(ACT_VERB_RISK).toEqual(EXPECTED);
  });

  it("classifyRisk reads the VERB, never the effect kind", () => {
    for (const [verb, expected] of Object.entries(EXPECTED)) {
      expect(classifyRisk([act(verb as ActVerb)]), `verb ${verb}`).toBe(expected);
    }
  });

  it("one destructive verb makes the whole plan destructive", () => {
    expect(classifyRisk([act("mute"), act("discard"), act("pin")])).toBe("destructive");
  });

  it("a closing effect still dominates everything", () => {
    expect(
      classifyRisk([
        act("mute"),
        { kind: "closeVerified", tabId: "t:chrome:x2", contingentOn: "s" },
      ]),
    ).toBe("destructive");
  });
});
