/**
 * Exponential-backoff retry policy for the Musubi HTTP client.
 *
 * Defaults match `docs/api-contract.md` §HTTP "Retries":
 *   delay_ms = min(2^n * 500ms + rand(0, 250ms), 8s), up to 5 attempts.
 *
 * The random source is injectable so tests can pin jitter to a fixed value
 * and assert deterministic backoff progression.
 */

export type RetryPolicy = {
  /** Maximum number of attempts including the initial one. */
  readonly maxAttempts: number;
  /** Base delay multiplied by `2^attempt`. */
  readonly baseDelayMs: number;
  /** Upper bound on the random jitter added each attempt. */
  readonly jitterMs: number;
  /** Hard cap; the final delay is `min(base * 2^n + jitter, maxDelayMs)`. */
  readonly maxDelayMs: number;
};

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 5,
  baseDelayMs: 500,
  jitterMs: 250,
  maxDelayMs: 8_000,
};

/**
 * Compute the delay to wait *before* the (attempt+1)-th retry.
 *
 * @param attempt 0-indexed attempt number that just failed.
 * @param policy  Retry configuration.
 * @param random  RNG returning a value in `[0, 1)`. Defaults to `Math.random`.
 */
export function nextDelayMs(
  attempt: number,
  policy: RetryPolicy = DEFAULT_RETRY_POLICY,
  random: () => number = Math.random,
): number {
  if (attempt < 0) {
    throw new RangeError(`attempt must be >= 0 (got ${attempt})`);
  }
  const exponential = policy.baseDelayMs * Math.pow(2, attempt);
  const jitter = random() * policy.jitterMs;
  return Math.min(exponential + jitter, policy.maxDelayMs);
}

export function mergeRetryPolicy(overrides: Partial<RetryPolicy> = {}): RetryPolicy {
  return { ...DEFAULT_RETRY_POLICY, ...overrides };
}
