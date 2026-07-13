/**
 * Bounded-memory list with gap markers — generic version of imsg's
 * `boundMessagesIfNeeded` (imsg-mcp/src/tui/types.ts:153-233).
 *
 * When a working list exceeds `hardCap`, evict the middle while preserving
 * two regions:
 *   - the last `anchorKeep` items (so G/end-of-list is always fast)
 *   - `windowBuffer` items around the cursor (current viewing window)
 *
 * The evicted middle is replaced by a single "gap marker" so the UI can
 * render a "N older items evicted" placeholder; the cursor index is
 * remapped to land on its original item if still present, or clamped to
 * the start of the gap otherwise.
 *
 * The caller defines what constitutes an "item" via the generic param T
 * and a `marker` factory. T must be union-able with the gap marker shape.
 */

export interface BoundedListConfig<T, Marker> {
  hardCap: number;
  anchorKeep: number;
  windowBuffer: number;
  /** Build a gap marker for `count` evicted items between `before` and `after` (inclusive). */
  makeMarker(count: number, before: T, after: T): Marker;
}

export interface BoundResult<T> {
  items: T[];
  cursorIndex: number;
  /** Number of items evicted (0 if no eviction). */
  evicted: number;
}

export function boundIfNeeded<T, Marker>(
  items: (T | Marker)[],
  cursorIndex: number,
  config: BoundedListConfig<T, Marker>,
): BoundResult<T | Marker> {
  if (items.length <= config.hardCap) {
    return { items, cursorIndex, evicted: 0 };
  }

  const len = items.length;
  const anchorStart = Math.max(0, len - config.anchorKeep);
  const windowStart = Math.max(0, cursorIndex - config.windowBuffer);
  const windowEnd = Math.min(len, cursorIndex + config.windowBuffer + 1);

  // Two regions to keep: [windowStart..windowEnd) and [anchorStart..len)
  // If they overlap, merge.
  if (anchorStart <= windowEnd) {
    // The window already includes the anchor — just trim the head.
    const newItems = items.slice(windowStart);
    return {
      items: newItems,
      cursorIndex: cursorIndex - windowStart,
      evicted: windowStart,
    };
  }

  // Disjoint — preserve both, insert one marker between them.
  const head = items.slice(windowStart, windowEnd);
  const tail = items.slice(anchorStart);
  const gapCount = anchorStart - windowEnd;
  const before = head[head.length - 1] as T;
  const after = tail[0] as T;
  const marker = config.makeMarker(gapCount, before, after);

  const newItems = [...head, marker, ...tail];
  return {
    items: newItems,
    cursorIndex: cursorIndex - windowStart,
    evicted: windowStart + gapCount,
  };
}
