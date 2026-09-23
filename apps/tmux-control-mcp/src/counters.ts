/**
 * In-process counters surfaced via health_check and the HTTP /health
 * endpoint.
 *
 * `recentErrors` is a sliding 5-minute window — old entries drop off as
 * we read it. Keeps the value useful without growing unbounded.
 */

let toolCalls = 0;
const recentErrorTs: number[] = [];
const ERROR_WINDOW_MS = 5 * 60_000;

export function recordToolCall(): void {
  toolCalls++;
}

export function recordToolError(): void {
  recentErrorTs.push(Date.now());
}

export function getCounters(): { toolCalls: number; recentErrors: number } {
  const cutoff = Date.now() - ERROR_WINDOW_MS;
  while (recentErrorTs.length > 0 && (recentErrorTs[0] ?? 0) < cutoff) {
    recentErrorTs.shift();
  }
  return { toolCalls, recentErrors: recentErrorTs.length };
}

/** @internal — test only */
export function _resetCounters(): void {
  toolCalls = 0;
  recentErrorTs.length = 0;
}
