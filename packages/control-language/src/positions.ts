/**
 * Signed positional semantics — spec §5, implemented exactly:
 *
 * - Absolute element positions are ONE-based and signed: 1 first, -1 last,
 *   0 invalid (rejected at the schema), positives count from the start,
 *   negatives from the end. Never wrap.
 * - Out-of-range absolute positions CLAMP to the nearest boundary by default;
 *   bounds:"error" turns clamping into E_OUT_OF_RANGE.
 * - Ranges are inclusive and preserve direction: a descending range yields a
 *   descending selection order (§5.3).
 * - Relative offsets are ZERO-based displacements from an anchor: 0 is the
 *   anchor, sign is direction. Out-of-range offsets CLIP (drop), never wrap
 *   (§5.2).
 *
 * All functions here are pure integer math over a sequence length; they never
 * see entities. The resolver maps the returned 0-based indexes onto resolved
 * sequences.
 */

import { fail } from "./errors.js";

export type Bounds = "clamp" | "error";

/**
 * Resolve one signed one-based position to a 0-based index.
 * Returns undefined when the sequence is empty under clamp (there is no
 * boundary to clamp to); throws under bounds:"error" whenever the position
 * does not land inside the sequence.
 */
export function resolveAbsolute(
  pos: number,
  length: number,
  bounds: Bounds,
  path: string,
): number | undefined {
  if (pos === 0) {
    // Schema rejects 0; this guards direct programmatic callers.
    fail(
      "E_OUT_OF_RANGE",
      path,
      "position 0 is invalid: positions are one-based and signed",
      "use 1 for the first element or -1 for the last",
    );
  }
  if (length === 0) {
    if (bounds === "error") {
      fail("E_OUT_OF_RANGE", path, `position ${pos} cannot resolve in an empty sequence`);
    }
    return undefined;
  }
  const raw = pos > 0 ? pos - 1 : length + pos;
  if (raw < 0 || raw >= length) {
    if (bounds === "error") {
      fail(
        "E_OUT_OF_RANGE",
        path,
        `position ${pos} is out of range for a sequence of length ${length}`,
        `valid positions are 1..${length} and -${length}..-1`,
      );
    }
    return raw < 0 ? 0 : length - 1;
  }
  return raw;
}

/**
 * Resolve an inclusive signed range to an ordered list of 0-based indexes,
 * preserving direction: from resolves before to, and the walk goes in the
 * direction of (to - from). A descending range is NOT normalized (§5.3).
 */
export function resolveRange(
  from: number,
  to: number,
  length: number,
  bounds: Bounds,
  path: string,
): number[] {
  const a = resolveAbsolute(from, length, bounds, `${path}.from`);
  const b = resolveAbsolute(to, length, bounds, `${path}.to`);
  if (a === undefined || b === undefined) return [];
  const step = a <= b ? 1 : -1;
  const out: number[] = [];
  for (let i = a; step > 0 ? i <= b : i >= b; i += step) out.push(i);
  return out;
}

/**
 * Resolve a zero-based relative offset range around an anchor index.
 * Offsets clip: indexes falling outside [0, length) are dropped, and the
 * result preserves the range's declared direction. No wrapping (§5.2).
 */
export function resolveOffsets(
  anchorIndex: number,
  from: number,
  to: number,
  length: number,
): number[] {
  const step = from <= to ? 1 : -1;
  const out: number[] = [];
  for (let o = from; step > 0 ? o <= to : o >= to; o += step) {
    const i = anchorIndex + o;
    if (i >= 0 && i < length) out.push(i);
  }
  return out;
}
