import { describe, expect, it } from "vitest";
import { EPISODIC_CONTENT_LIMIT_BYTES } from "../../src/capture/limits.js";
import {
  type CaptureEvent,
  deriveIdempotencyKey,
  TAG_TRUNCATED,
  toCanonicalCapture,
  translateCaptureEvent,
} from "../../src/capture/translate.js";
import type { PresenceContext } from "../../src/presence/resolver.js";

const presence: PresenceContext = {
  presence: "eric/openclaw",
  token: "tok",
  namespaces: {
    episodic: "eric/openclaw/episodic",
    thought: "eric/openclaw/thought",
    artifact: "eric/openclaw/artifact",
    curatedReadScope: ["eric/openclaw/curated", "eric/_shared/curated"],
  },
};

const fixedNow = () => new Date("2026-04-20T05:00:00.000Z");

describe("translateCaptureEvent", () => {
  it("test_mirror_translates_openclaw_memory_to_episodic_shape", () => {
    const event: CaptureEvent = {
      id: "openclaw-mem-123",
      content: "Eric mentioned wanting to ship Musubi v2 this quarter.",
      agentId: "aoi",
      importance: 7,
      topics: ["musubi", "roadmap"],
    };

    const payload = translateCaptureEvent(event, presence, fixedNow);

    expect(payload).toEqual({
      namespace: "eric/openclaw/episodic",
      content: "Eric mentioned wanting to ship Musubi v2 this quarter.",
      capture_source: "openclaw-agent-end",
      source_ref: "openclaw-mem-123",
      timestamp: "2026-04-20T05:00:00.000Z",
      importance: 7,
      topics: ["musubi", "roadmap"],
      metadata: {},
    });
  });

  it("defaults importance to 5 (neutral) when absent", () => {
    const payload = translateCaptureEvent({ id: "x", content: "hello" }, presence, fixedNow);
    expect(payload.importance).toBe(5);
  });

  it("clamps importance to [1,10]", () => {
    const high = translateCaptureEvent(
      { id: "x", content: "hello", importance: 99 },
      presence,
      fixedNow,
    );
    const low = translateCaptureEvent(
      { id: "x", content: "hello", importance: -3 },
      presence,
      fixedNow,
    );
    const nan = translateCaptureEvent(
      { id: "x", content: "hello", importance: Number.NaN },
      presence,
      fixedNow,
    );
    expect(high.importance).toBe(10);
    expect(low.importance).toBe(1);
    expect(nan.importance).toBe(5);
  });

  it("uses event timestamp when provided", () => {
    const payload = translateCaptureEvent(
      { id: "x", content: "hello", timestamp: "2025-01-01T00:00:00.000Z" },
      presence,
      fixedNow,
    );
    expect(payload.timestamp).toBe("2025-01-01T00:00:00.000Z");
  });

  it("passes through metadata and defaults topics to []", () => {
    const payload = translateCaptureEvent(
      { id: "x", content: "hello", metadata: { thread: "abc" } },
      presence,
      fixedNow,
    );
    expect(payload.metadata).toEqual({ thread: "abc" });
    expect(payload.topics).toEqual([]);
  });
});

describe("deriveIdempotencyKey", () => {
  it("test_mirror_idempotency_key_is_stable_per_source_memory_id", () => {
    const event: CaptureEvent = { id: "openclaw-mem-abc", content: "x" };
    expect(deriveIdempotencyKey(event)).toBe("openclaw-mirror:openclaw-mem-abc");
    expect(deriveIdempotencyKey(event)).toBe(deriveIdempotencyKey(event));
  });
});

describe("toCanonicalCapture oversize handling", () => {
  const bytes = (value: string) => new TextEncoder().encode(value).length;

  it("fits an oversized turn under the server ceiling and tags the cut", () => {
    const payload = translateCaptureEvent(
      { id: "e1", content: "あ".repeat(20_000) },
      presence,
      fixedNow,
    );

    const body = toCanonicalCapture(payload);

    // Musubi 422s a capture over 32768 UTF-8 bytes, and a 422 is terminal —
    // so without this the whole turn dead-letters and the memory is lost.
    expect(bytes(body.content)).toBeLessThanOrEqual(EPISODIC_CONTENT_LIMIT_BYTES);
    expect(body.content).toContain("capture truncated by openclaw-musubi");
    expect(body.tags).toContain(TAG_TRUNCATED);
  });

  it("leaves an ordinary turn and its tags alone", () => {
    const payload = translateCaptureEvent(
      { id: "e2", content: "a normal turn" },
      presence,
      fixedNow,
    );

    const body = toCanonicalCapture(payload);

    expect(body.content).toBe("a normal turn");
    expect(body.tags).not.toContain(TAG_TRUNCATED);
  });
});
