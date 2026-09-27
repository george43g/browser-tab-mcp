import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { readTmuxSnapshot } from "./adapter/read.js";
import { previewSplitImpact } from "./preview.js";

const available = spawnSync("tmux", ["-V"], { encoding: "utf8" }).status === 0;
const effectIt = available ? it : it.skip;
const socket = `codex-m3-test-${process.pid}-${Date.now()}`;
const tmux = (...args: string[]) =>
  spawnSync("tmux", ["-L", socket, ...args], {
    encoding: "utf8",
    timeout: 10_000,
    env: { ...process.env, TMUX: "" },
  });

effectIt("linked presentation and a session group share one window and one pane set", async () => {
  try {
    expect(
      tmux("-f", "/dev/null", "new-session", "-d", "-s", "claude", "-n", "agent", "sleep 60")
        .status,
    ).toBe(0);
    expect(tmux("new-session", "-d", "-t", "claude", "-s", "claude-agent").status).toBe(0);
    expect(tmux("new-session", "-d", "-s", "presentation", "-n", "spare", "sleep 60").status).toBe(
      0,
    );
    expect(tmux("link-window", "-d", "-s", "claude:0", "-t", "presentation:1").status).toBe(0);

    const before = await readTmuxSnapshot({ socketName: socket });
    const claude = before.sessions.find((session) => session.name === "claude");
    const group = before.sessions.find((session) => session.name === "claude-agent");
    const presentation = before.sessions.find((session) => session.name === "presentation");
    expect(claude && group && presentation).toBeTruthy();
    const claudeSlot = before.slots.find((slot) => slot.sessionId === claude?.id);
    const groupSlot = before.slots.find((slot) => slot.sessionId === group?.id);
    const presentationSlot = before.slots.find(
      (slot) => slot.sessionId === presentation?.id && slot.index === 1,
    );
    if (!claudeSlot || !groupSlot || !presentationSlot) throw new Error("Linked slots missing");
    expect(claudeSlot.windowId).toBe(presentationSlot.windowId);
    expect(groupSlot.windowId).toBe(presentationSlot.windowId);

    const impact = previewSplitImpact(before, presentationSlot.key);
    expect(impact.affectedSlots.map((slot) => slot.sessionName).sort()).toEqual([
      "claude",
      "claude-agent",
    ]);
    expect(impact.message).toContain(
      `also changes window ${presentationSlot.windowId} as seen in session claude`,
    );
    const paneCount = before.panes.filter(
      (pane) => pane.windowId === presentationSlot.windowId,
    ).length;

    expect(tmux("split-window", "-d", "-t", "presentation:1", "sleep 60").status).toBe(0);
    const after = await readTmuxSnapshot({ socketName: socket });
    expect(after.panes.filter((pane) => pane.windowId === presentationSlot.windowId)).toHaveLength(
      paneCount + 1,
    );
    expect(after.slots.filter((slot) => slot.windowId === presentationSlot.windowId)).toHaveLength(
      3,
    );
  } finally {
    tmux("kill-server");
  }
});
