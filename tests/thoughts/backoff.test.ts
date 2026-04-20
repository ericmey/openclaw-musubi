import { describe, it, expect } from "vitest";
import { nextSseBackoffMs } from "../../src/thoughts/backoff.js";

describe("nextSseBackoffMs", () => {
  it("test_stream_reconnects_with_exponential_backoff_jitter_on_drop", () => {
    // Pure-exponential progression with random pinned to 0 (no jitter):
    // 1s, 2s, 4s, 8s, 16s, 32s, then capped at 60s.
    const noJitter = () => 0;
    expect(nextSseBackoffMs(0, { random: noJitter })).toBe(1_000);
    expect(nextSseBackoffMs(1, { random: noJitter })).toBe(2_000);
    expect(nextSseBackoffMs(2, { random: noJitter })).toBe(4_000);
    expect(nextSseBackoffMs(3, { random: noJitter })).toBe(8_000);
    expect(nextSseBackoffMs(4, { random: noJitter })).toBe(16_000);
    expect(nextSseBackoffMs(5, { random: noJitter })).toBe(32_000);
    expect(nextSseBackoffMs(6, { random: noJitter })).toBe(60_000);
    expect(nextSseBackoffMs(20, { random: noJitter })).toBe(60_000);

    // Full-jitter (~1s extra) below the cap:
    const fullJitter = () => 0.999_999;
    const j0 = nextSseBackoffMs(0, { random: fullJitter });
    expect(j0).toBeGreaterThan(1_999);
    expect(j0).toBeLessThan(2_001);
    expect(nextSseBackoffMs(20, { random: fullJitter })).toBe(60_000); // still capped
  });

  it("rejects negative attempts", () => {
    expect(() => nextSseBackoffMs(-1)).toThrowError(RangeError);
  });

  it("respects custom maxDelayMs override", () => {
    const noJitter = () => 0;
    expect(nextSseBackoffMs(20, { maxDelayMs: 5_000, random: noJitter })).toBe(5_000);
  });
});
