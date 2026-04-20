import { describe, it, expect } from "vitest";
import { DEFAULT_RETRY_POLICY, mergeRetryPolicy, nextDelayMs } from "../../src/musubi/retry.js";

describe("retry policy", () => {
  it("test_retry_backoff_respects_bounds", () => {
    const noJitter = () => 0;
    const fullJitter = () => 0.999_999_9;

    // No-jitter: pure exponential 500ms * 2^attempt, capped at 8000ms.
    expect(nextDelayMs(0, DEFAULT_RETRY_POLICY, noJitter)).toBe(500);
    expect(nextDelayMs(1, DEFAULT_RETRY_POLICY, noJitter)).toBe(1_000);
    expect(nextDelayMs(2, DEFAULT_RETRY_POLICY, noJitter)).toBe(2_000);
    expect(nextDelayMs(3, DEFAULT_RETRY_POLICY, noJitter)).toBe(4_000);
    expect(nextDelayMs(4, DEFAULT_RETRY_POLICY, noJitter)).toBe(8_000);
    expect(nextDelayMs(5, DEFAULT_RETRY_POLICY, noJitter)).toBe(8_000);
    expect(nextDelayMs(20, DEFAULT_RETRY_POLICY, noJitter)).toBe(8_000);

    // Full-jitter (~250ms): bounded by maxDelayMs at high attempts.
    expect(nextDelayMs(0, DEFAULT_RETRY_POLICY, fullJitter)).toBeGreaterThan(749);
    expect(nextDelayMs(0, DEFAULT_RETRY_POLICY, fullJitter)).toBeLessThan(751);
    expect(nextDelayMs(10, DEFAULT_RETRY_POLICY, fullJitter)).toBe(8_000);
  });

  it("rejects negative attempts", () => {
    expect(() => nextDelayMs(-1)).toThrowError(RangeError);
  });

  it("merges overrides on top of defaults", () => {
    const merged = mergeRetryPolicy({ maxAttempts: 2 });
    expect(merged.maxAttempts).toBe(2);
    expect(merged.baseDelayMs).toBe(DEFAULT_RETRY_POLICY.baseDelayMs);
    expect(merged.maxDelayMs).toBe(DEFAULT_RETRY_POLICY.maxDelayMs);
  });
});
