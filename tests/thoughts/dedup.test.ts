import { describe, it, expect } from "vitest";
import { BoundedDedupSet, DEFAULT_DEDUP_MAX_SIZE } from "../../src/thoughts/dedup.js";

describe("BoundedDedupSet", () => {
  it("test_stream_dedup_set_caps_at_1000_entries_or_1h_ttl", () => {
    // Default cap is 1000 per the spec rule.
    expect(DEFAULT_DEDUP_MAX_SIZE).toBe(1_000);

    const dedup = new BoundedDedupSet({ maxSize: 3, now: () => 100 });
    expect(dedup.add("a")).toBe(true);
    expect(dedup.add("b")).toBe(true);
    expect(dedup.add("c")).toBe(true);
    expect(dedup.size()).toBe(3);

    // Adding a fourth evicts the oldest (a).
    expect(dedup.add("d")).toBe(true);
    expect(dedup.size()).toBe(3);
    expect(dedup.has("a")).toBe(false);
    expect(dedup.has("d")).toBe(true);
  });

  it("test_stream_skips_events_already_in_dedup_set", () => {
    const dedup = new BoundedDedupSet();
    expect(dedup.add("ksuid-1")).toBe(true);
    expect(dedup.add("ksuid-1")).toBe(false);
    expect(dedup.has("ksuid-1")).toBe(true);
    expect(dedup.size()).toBe(1);
  });

  it("expires entries past TTL", () => {
    let nowValue = 1_000;
    const dedup = new BoundedDedupSet({
      ttlMs: 100,
      now: () => nowValue,
    });

    dedup.add("ephemeral");
    expect(dedup.has("ephemeral")).toBe(true);

    nowValue += 50;
    expect(dedup.has("ephemeral")).toBe(true);

    nowValue += 100;
    expect(dedup.has("ephemeral")).toBe(false);
    expect(dedup.size()).toBe(0);
  });
});
