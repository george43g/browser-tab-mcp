import type { TmuxSnapshot } from "./model.js";

export interface SharedSlotImpact {
  key: string;
  sessionName: string;
  index: number;
}

/** Describe the visible consequence of splitting a window reached through a slot. */
export function previewSplitImpact(
  snapshot: TmuxSnapshot,
  slotKey: string,
): { windowId: string; affectedSlots: SharedSlotImpact[]; message: string } {
  const slot = snapshot.slots.find((candidate) => candidate.key === slotKey);
  if (!slot) throw new Error(`Unknown tmux slot ${slotKey}; refresh the snapshot and retry.`);
  const sessionName = (id: string): string => {
    const session = snapshot.sessions.find((candidate) => candidate.id === id);
    if (!session) throw new Error(`Unknown tmux session ${id}; refresh the snapshot and retry.`);
    return session.name;
  };
  const sourceName = sessionName(slot.sessionId);
  const affectedSlots = snapshot.slots
    .filter((candidate) => candidate.windowId === slot.windowId && candidate.key !== slot.key)
    .map((candidate) => ({
      key: candidate.key,
      sessionName: sessionName(candidate.sessionId),
      index: candidate.index,
    }));
  const prefix = `Splitting window ${slot.windowId} through slot ${slot.index} in session ${sourceName}`;
  const message =
    affectedSlots.length === 0
      ? `${prefix} changes that window and its panes. No other slot links to it.`
      : `${prefix} also changes window ${slot.windowId} as seen in ${affectedSlots
          .map((other) => `session ${other.sessionName} (slot ${other.index})`)
          .join(", ")}; these slots share the same window and panes.`;
  return { windowId: slot.windowId, affectedSlots, message };
}
