/**
 * Exponential backoff with jitter for the SSE thought-stream reconnect.
 *
 * Per `docs/api-contract.md` §SSE rule 1 (mirroring upstream
 * canonical-api §5 "Consumer expectations"):
 *
 *     delay_ms = min(2^n * 1000ms + rand(0, 1000ms), 60s)
 *
 * `n` starts at 0, increments on each failed reconnect attempt, and is
 * reset to 0 by the consumer once a connection has been stable for
 * 5 minutes.
 *
 * Pure function. Tests pin `random` to a fixed value to assert the
 * progression and the cap.
 */

export const SSE_BASE_DELAY_MS = 1_000;
export const SSE_JITTER_MS = 1_000;
export const SSE_MAX_DELAY_MS = 60_000;

export function nextSseBackoffMs(
  attempt: number,
  options: { readonly maxDelayMs?: number; readonly random?: () => number } = {},
): number {
  if (attempt < 0) {
    throw new RangeError(`attempt must be >= 0 (got ${attempt})`);
  }
  const maxDelayMs = options.maxDelayMs ?? SSE_MAX_DELAY_MS;
  const random = options.random ?? Math.random;

  const exponential = SSE_BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = random() * SSE_JITTER_MS;
  return Math.min(exponential + jitter, maxDelayMs);
}
