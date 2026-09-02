/**
 * Window-order diffing — the planner's one ordering mechanism.
 *
 * Every ordering transform (block move landing, setOrder, sort, reverse,
 * swap, pack) reduces to: "this window's tab strip should read as ORDER".
 * `relocationsFor(current, desired)` emits the minimal after-chained
 * relocations: tabs on a longest increasing subsequence of the desired
 * arrangement (measured in current positions) stay put; every other tab is
 * relocated once, in desired order, chained by neighbor identity.
 *
 * Why LIS and not "move everything": spec §11.4 — avoid moving tabs already
 * in correct relative order. Why after-chaining: spec §14.2 — effects carry
 * identities and gaps, never concrete indexes; the executor translates
 * against live state.
 */

import type { RelocateEffect } from "./effects.js";

/** Indices (into the input array) of one longest increasing subsequence. */
function lisIndices(pos: readonly number[]): Set<number> {
  // Patience sorting with predecessor links — O(n log n).
  const tails: number[] = []; // index into pos of the smallest tail per length
  const prev = new Array<number>(pos.length).fill(-1);
  for (let i = 0; i < pos.length; i++) {
    const v = pos[i] as number;
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((pos[tails[mid] as number] as number) < v) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1] as number;
    tails[lo] = i;
  }
  const keep = new Set<number>();
  let k = tails.length > 0 ? (tails[tails.length - 1] as number) : -1;
  while (k >= 0) {
    keep.add(k);
    k = prev[k] as number;
  }
  return keep;
}

/**
 * Minimal after-chained relocations turning `current` into `desired` within
 * one window. Every current id must appear in `desired` (nothing is removed
 * here — a tab leaves a window only by relocating INTO another window, in
 * that window's own arrangement); `desired` may additionally contain
 * INCOMING ids from other windows, which always relocate. A malformed pair
 * throws — a partition mismatch must never be silently "fixed" here.
 */
export function relocationsFor(
  current: readonly string[],
  desired: readonly string[],
  windowId: string,
): RelocateEffect[] {
  const currentIndex = new Map(current.map((id, i) => [id, i]));
  if (
    new Set(current).size !== current.length ||
    new Set(desired).size !== desired.length ||
    !current.every((id) => desired.includes(id))
  ) {
    throw new Error(
      `relocationsFor: desired order must contain every current tab exactly once ` +
        `(current ${current.length}, desired ${desired.length})`,
    );
  }
  // LIS over the desired positions of tabs already IN this window; incoming
  // tabs are not candidates to keep — they must relocate regardless.
  const residentDesiredIdx: number[] = [];
  const pos: number[] = [];
  for (let i = 0; i < desired.length; i++) {
    const cur = currentIndex.get(desired[i] as string);
    if (cur !== undefined) {
      residentDesiredIdx.push(i);
      pos.push(cur);
    }
  }
  const keptResident = lisIndices(pos);
  const keep = new Set<number>();
  for (const [j, di] of residentDesiredIdx.entries()) {
    if (keptResident.has(j)) keep.add(di);
  }

  const effects: RelocateEffect[] = [];
  for (let i = 0; i < desired.length; i++) {
    if (keep.has(i)) continue;
    const id = desired[i] as string;
    // Land after the desired left neighbour (null = front). By emission in
    // desired order, that neighbour is already in place (kept, or relocated
    // by an earlier effect), so the chain is valid at apply time.
    effects.push({
      kind: "relocate",
      tabId: id,
      targetWindowId: windowId,
      after: i === 0 ? null : (desired[i - 1] as string),
    });
  }
  return effects;
}
