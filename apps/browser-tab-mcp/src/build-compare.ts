/**
 * Comparing build stamps across artifacts (pure — unit testable).
 *
 * The protocol-version staleness check only catches a bundle old enough to
 * speak an OLDER wire version. A rebuild that was never reloaded speaks the
 * same protocol while running different code, so it looks healthy right up
 * until something misbehaves. Comparing build identity closes that gap.
 */

/**
 * The commit identity inside a stamp — `<count>.<sha>` — with the dirty
 * marker and its timestamp stripped.
 *
 * Dirty noise is deliberately ignored: two builds of the same commit, one with
 * uncommitted edits, are close enough that flagging them would cry wolf during
 * normal development. What matters is whether the artifacts came from the same
 * source revision.
 */
export function commitOf(stamp: string): string | null {
  const plus = stamp.indexOf("+");
  if (plus === -1) return null;
  const rest = stamp.slice(plus + 1);
  const commit = rest.split(".dirty")[0]?.split(".dev")[0] ?? "";
  return commit.length > 0 ? commit : null;
}

export type BuildComparison =
  /** Same source revision. */
  | { kind: "match" }
  /** One side has no stamp — it predates build stamping. */
  | { kind: "unstamped" }
  /** Different source revisions: something was rebuilt but not reloaded. */
  | { kind: "mismatch"; daemon: string; other: string };

export function compareBuilds(daemonStamp: string, otherStamp: string): BuildComparison {
  const d = commitOf(daemonStamp);
  const o = commitOf(otherStamp);
  if (d === null || o === null) return { kind: "unstamped" };
  return d === o ? { kind: "match" } : { kind: "mismatch", daemon: d, other: o };
}
