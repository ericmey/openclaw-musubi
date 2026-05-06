/**
 * Exponential-backoff retry policy for the Musubi HTTP client.
 *
 * Defaults match `docs/api-contract.md` §HTTP "Retries":
 *   delay_ms = min(2^n * 500ms + rand(0, 250ms), 8s), up to 5 attempts.
 *
 * The random source is injectable so tests can pin jitter to a fixed value
 * and assert deterministic backoff progression.
 */
export const DEFAULT_RETRY_POLICY = {
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
export function nextDelayMs(attempt, policy = DEFAULT_RETRY_POLICY, random = Math.random) {
    if (attempt < 0) {
        throw new RangeError(`attempt must be >= 0 (got ${attempt})`);
    }
    const exponential = policy.baseDelayMs * Math.pow(2, attempt);
    const jitter = random() * policy.jitterMs;
    return Math.min(exponential + jitter, policy.maxDelayMs);
}
export function mergeRetryPolicy(overrides = {}) {
    return { ...DEFAULT_RETRY_POLICY, ...overrides };
}
//# sourceMappingURL=retry.js.map