import { describe, expect, it } from "vitest";
import { boundIfNeeded } from "./bounded-list.js";

interface Item {
  id: number;
}
interface Marker {
  kind: "gap";
  count: number;
  beforeId: number;
  afterId: number;
}

function makeMarker(count: number, before: Item, after: Item): Marker {
  return { kind: "gap", count, beforeId: before.id, afterId: after.id };
}

describe("boundIfNeeded", () => {
  it("returns input unchanged when under hardCap", () => {
    const items: Item[] = [{ id: 1 }, { id: 2 }];
    const r = boundIfNeeded(items, 1, {
      hardCap: 100,
      anchorKeep: 10,
      windowBuffer: 5,
      makeMarker,
    });
    expect(r.items).toEqual(items);
    expect(r.cursorIndex).toBe(1);
    expect(r.evicted).toBe(0);
  });

  it("preserves anchor + window when disjoint", () => {
    // 100 items, cursor at index 10. Anchor keeps last 5; window keeps ±2 around cursor.
    const items: Item[] = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const r = boundIfNeeded(items, 10, {
      hardCap: 50,
      anchorKeep: 5,
      windowBuffer: 2,
      makeMarker,
    });
    // window = [8,9,10,11,12]  anchor = [95..99]  gap_marker_count = 95 - 13 = 82
    expect(r.items).toHaveLength(5 + 1 + 5);
    expect((r.items[5] as Marker).kind).toBe("gap");
    expect((r.items[5] as Marker).count).toBe(82);
  });

  it("merges when window and anchor overlap (cursor near end)", () => {
    const items: Item[] = Array.from({ length: 100 }, (_, i) => ({ id: i }));
    const r = boundIfNeeded(items, 95, {
      hardCap: 50,
      anchorKeep: 10,
      windowBuffer: 5,
      makeMarker,
    });
    expect(r.items.every((it) => "id" in it)).toBe(true);
  });
});
