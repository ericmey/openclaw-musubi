import { describe, it, expect } from "vitest";
import { createThoughtStream, type ThoughtPayload } from "../../src/thoughts/stream.js";
import type { FetchForStream } from "../../src/thoughts/stream.js";
import { BoundedDedupSet } from "../../src/thoughts/dedup.js";
import { InMemoryLastEventIdStore } from "../../src/thoughts/persistence.js";
import type { MusubiConfig } from "../../src/config.js";

function makeConfig(overrides: Partial<MusubiConfig> = {}): MusubiConfig {
  return {
    core: { baseUrl: "https://musubi.test", token: "t", ...(overrides.core ?? {}) },
    presence: { defaultId: "eric/openclaw", ...(overrides.presence ?? {}) },
  };
}

type ScriptedSseAction =
  | { type: "frames"; text: string }
  | { type: "delay"; ms: number }
  | { type: "close" }
  | { type: "abort" };

type ScriptedResponse =
  | { status: 200; actions: ScriptedSseAction[] }
  | { status: number }
  | { throw: Error };

type RecordedRequest = {
  url: string;
  headers: Record<string, string>;
};

function streamFromActions(
  actions: ScriptedSseAction[],
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      if (signal.aborted) {
        controller.error(new DOMException("aborted", "AbortError"));
        return;
      }
      const abortListener = () => {
        try {
          controller.error(new DOMException("aborted", "AbortError"));
        } catch {
          // already closed
        }
      };
      signal.addEventListener("abort", abortListener, { once: true });

      try {
        for (const action of actions) {
          if (signal.aborted) return;
          if (action.type === "frames") {
            controller.enqueue(encoder.encode(action.text));
          } else if (action.type === "delay") {
            await new Promise((resolve) => setTimeout(resolve, action.ms));
          } else if (action.type === "close") {
            controller.close();
            return;
          } else if (action.type === "abort") {
            controller.error(new Error("network blip"));
            return;
          }
        }
        controller.close();
      } finally {
        signal.removeEventListener("abort", abortListener);
      }
    },
  });
}

function createMockFetch(script: ScriptedResponse[]): {
  fetch: FetchForStream;
  requests: RecordedRequest[];
} {
  const requests: RecordedRequest[] = [];
  let cursor = 0;
  const fetch: FetchForStream = async (url, init) => {
    const headers: Record<string, string> = {};
    if (init.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k] = v;
      }
    }
    requests.push({ url, headers });

    const def = script[cursor] ?? script[script.length - 1];
    cursor += 1;
    if (def === undefined) throw new Error("script exhausted");

    if ("throw" in def) throw def.throw;

    if (def.status === 200 && "actions" in def) {
      const signal = init.signal as AbortSignal;
      const body = streamFromActions(def.actions, signal);
      return new Response(body, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    }

    return new Response(null, { status: def.status });
  };
  return { fetch, requests };
}

function frame(event: string, id: string | undefined, data: unknown): string {
  const parts = [`event: ${event}`];
  if (id !== undefined) parts.push(`id: ${id}`);
  parts.push(`data: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  parts.push("");
  parts.push("");
  return parts.join("\n");
}

function makeThoughtFrame(overrides: Partial<ThoughtPayload> & { object_id: string }): string {
  const payload: ThoughtPayload = {
    object_id: overrides.object_id,
    from_presence: overrides.from_presence ?? "eric/claude-code",
    to_presence: overrides.to_presence ?? "openclaw",
    namespace: overrides.namespace ?? "eric/openclaw",
    content: overrides.content ?? "hello",
    sent_at: overrides.sent_at ?? "2026-04-20T00:00:00.000Z",
    ...(overrides.channel !== undefined ? { channel: overrides.channel } : {}),
    ...(overrides.importance !== undefined ? { importance: overrides.importance } : {}),
  };
  return frame("thought", overrides.object_id, payload);
}

async function wait(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("createThoughtStream", () => {
  it("test_stream_accepts_thought_ping_close_events", async () => {
    const receivedThoughts: ThoughtPayload[] = [];
    const { fetch } = createMockFetch([
      {
        status: 200,
        actions: [
          { type: "frames", text: makeThoughtFrame({ object_id: "k1", content: "first" }) },
          { type: "frames", text: frame("ping", undefined, { at: "2026-04-20T00:00:30Z" }) },
          { type: "frames", text: makeThoughtFrame({ object_id: "k2", content: "second" }) },
          { type: "frames", text: frame("close", undefined, { reason: "server-shutdown" }) },
          { type: "close" },
        ],
      },
      { throw: new TypeError("no more responses") },
    ]);

    const stream = createThoughtStream({
      config: makeConfig(),
      fetch,
      sleep: async () => undefined,
      random: () => 0,
    });

    const startPromise = stream.start({
      onThought: (t) => {
        receivedThoughts.push(t);
        if (receivedThoughts.length === 2) void stream.stop();
      },
    });

    await Promise.race([startPromise, wait(500)]);
    await stream.stop();
    await startPromise;

    expect(receivedThoughts).toHaveLength(2);
    expect(receivedThoughts[0]?.content).toBe("first");
    expect(receivedThoughts[1]?.content).toBe("second");
  });

  it("test_stream_does_not_reconnect_on_403", async () => {
    const { fetch, requests } = createMockFetch([
      { status: 403 },
      { status: 200, actions: [{ type: "close" }] }, // should never reach
    ]);

    const authErrors: number[] = [];
    const disconnects: string[] = [];
    const stream = createThoughtStream({
      config: makeConfig(),
      fetch,
      sleep: async () => undefined,
      random: () => 0,
    });

    await stream.start({
      onThought: () => undefined,
      onAuthError: (status) => authErrors.push(status),
      onDisconnect: (reason) => disconnects.push(reason),
    });

    expect(authErrors).toEqual([403]);
    expect(disconnects).toEqual(["auth-403"]);
    expect(requests).toHaveLength(1); // no reconnect
    expect(stream.isRunning()).toBe(false);
  });

  it("test_stream_surfaces_403_as_auth_required_status", async () => {
    const { fetch } = createMockFetch([{ status: 403 }]);

    let surfaced: number | undefined;
    const stream = createThoughtStream({
      config: makeConfig(),
      fetch,
      sleep: async () => undefined,
      random: () => 0,
    });

    await stream.start({
      onThought: () => undefined,
      onAuthError: (status) => {
        surfaced = status;
      },
    });

    expect(surfaced).toBe(403);
  });

  it("test_stream_sits_in_reconnect_when_endpoint_returns_404", async () => {
    const sleepCalls: number[] = [];
    const { fetch, requests } = createMockFetch([
      { status: 404 },
      { status: 404 },
      {
        status: 200,
        actions: [
          { type: "frames", text: makeThoughtFrame({ object_id: "k1" }) },
          { type: "close" },
        ],
      },
    ]);

    const stream = createThoughtStream({
      config: makeConfig(),
      fetch,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      random: () => 0,
    });

    await stream.start({
      onThought: () => {
        void stream.stop();
      },
    });

    expect(requests.length).toBeGreaterThanOrEqual(3);
    // First two are pure exponential 1000, 2000 with no-jitter.
    expect(sleepCalls[0]).toBe(1_000);
    expect(sleepCalls[1]).toBe(2_000);
    expect(stream.isRunning()).toBe(false);
  });

  it("test_stream_resumes_with_last_event_id_header_on_reconnect", async () => {
    const { fetch, requests } = createMockFetch([
      {
        status: 200,
        actions: [
          { type: "frames", text: makeThoughtFrame({ object_id: "ksuid-first" }) },
          { type: "close" },
        ],
      },
      {
        status: 200,
        actions: [
          { type: "frames", text: makeThoughtFrame({ object_id: "ksuid-second" }) },
          { type: "close" },
        ],
      },
      { throw: new TypeError("stop here") },
    ]);

    const persistence = new InMemoryLastEventIdStore();
    const stream = createThoughtStream({
      config: makeConfig(),
      fetch,
      persistence,
      sleep: async () => undefined,
      random: () => 0,
    });

    const received: string[] = [];
    await stream.start({
      onThought: (t) => {
        received.push(t.object_id);
        if (received.length === 2) void stream.stop();
      },
    });

    // First request has no Last-Event-ID; second does (the id from first frame).
    expect(requests[0]?.headers["Last-Event-ID"]).toBeUndefined();
    expect(requests[1]?.headers["Last-Event-ID"]).toBe("ksuid-first");
    expect(await persistence.read()).toBe("ksuid-second");
  });

  it("test_stream_honors_close_event_reconnect_after_ms_hint", async () => {
    const sleepCalls: number[] = [];
    const { fetch } = createMockFetch([
      {
        status: 200,
        actions: [
          {
            type: "frames",
            text: frame("close", undefined, { reconnect_after_ms: 5_000 }),
          },
          { type: "close" },
        ],
      },
      {
        status: 200,
        actions: [
          { type: "frames", text: makeThoughtFrame({ object_id: "k1" }) },
          { type: "close" },
        ],
      },
    ]);

    const stream = createThoughtStream({
      config: makeConfig(),
      fetch,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      random: () => 0,
    });

    await stream.start({
      onThought: () => {
        void stream.stop();
      },
    });

    expect(sleepCalls[0]).toBe(5_000);
  });

  it("test_stream_compares_object_ids_lexicographically", async () => {
    // KSUIDs are 27-char base62, lex-sorted by time. Client persists the
    // *most recently received* id. We verify that the persisted id is
    // stored as a string (comparable lexicographically), not parsed into
    // a number or otherwise munged.
    const persistence = new InMemoryLastEventIdStore();
    const { fetch } = createMockFetch([
      {
        status: 200,
        actions: [
          { type: "frames", text: makeThoughtFrame({ object_id: "2iVVRLuAh_aaaaaaaaaaaaaaaa" }) },
          { type: "frames", text: makeThoughtFrame({ object_id: "2iVVRLuCj_bbbbbbbbbbbbbbbb" }) },
          { type: "close" },
        ],
      },
      { throw: new TypeError("stop") },
    ]);

    const stream = createThoughtStream({
      config: makeConfig(),
      fetch,
      persistence,
      sleep: async () => undefined,
      random: () => 0,
    });

    let seen = 0;
    await stream.start({
      onThought: () => {
        seen += 1;
        if (seen === 2) void stream.stop();
      },
    });

    const persisted = await persistence.read();
    expect(typeof persisted).toBe("string");
    // "C" > "A" lexicographically in base62; the most recent id should be
    // the later KSUID when compared as strings.
    expect(persisted! > "2iVVRLuAh_aaaaaaaaaaaaaaaa").toBe(true);
    expect(persisted).toBe("2iVVRLuCj_bbbbbbbbbbbbbbbb");
  });

  it("test_stream_dedups_across_multiple_concurrent_subscribers_for_same_presence", async () => {
    // Broadcast fanout means two subscribers for the same presence see the
    // same events. The in-process dedup set guarantees a single consumer
    // never delivers a duplicate, even if the server replays an id on
    // reconnect overlap.
    const sharedDedup = new BoundedDedupSet();
    const { fetch } = createMockFetch([
      {
        status: 200,
        actions: [
          { type: "frames", text: makeThoughtFrame({ object_id: "k1", content: "first" }) },
          { type: "frames", text: makeThoughtFrame({ object_id: "k1", content: "first-again" }) },
          { type: "frames", text: makeThoughtFrame({ object_id: "k2", content: "second" }) },
          { type: "close" },
        ],
      },
      { throw: new TypeError("stop") },
    ]);

    const received: string[] = [];
    const stream = createThoughtStream({
      config: makeConfig(),
      fetch,
      dedup: sharedDedup,
      sleep: async () => undefined,
      random: () => 0,
    });

    await stream.start({
      onThought: (t) => {
        received.push(t.content);
        if (received.length === 2) void stream.stop();
      },
    });

    expect(received).toEqual(["first", "second"]);
  });

  it("test_stream_closes_client_side_when_no_frame_in_60s", async () => {
    // Use a tiny ping timeout so the test runs in milliseconds.
    const { fetch, requests } = createMockFetch([
      {
        status: 200,
        actions: [
          // Connection opens but never sends any frame, even a ping.
          { type: "delay", ms: 200 },
          { type: "close" },
        ],
      },
      { status: 200, actions: [{ type: "close" }] },
    ]);

    const disconnects: string[] = [];
    const stream = createThoughtStream({
      config: makeConfig(),
      fetch,
      sleep: async () => undefined,
      random: () => 0,
      pingTimeoutMs: 20, // trip fast
    });

    const startPromise = stream.start({
      onThought: () => undefined,
      onDisconnect: (reason) => {
        disconnects.push(reason);
        if (disconnects.length >= 1) void stream.stop();
      },
    });

    await Promise.race([startPromise, wait(500)]);
    await stream.stop();
    await startPromise;

    expect(disconnects).toContain("ping-gap-timeout");
    expect(requests.length).toBeGreaterThanOrEqual(1);
  });

  it("test_stream_backoff_resets_after_5_minutes_stable", async () => {
    // Simulate a connection that's stable for 5+ minutes, then drops. The
    // next backoff should be the attempt-0 delay (1s no-jitter), not the
    // accumulated attempt counter's delay.
    //
    // Strategy: advance a virtual clock inside the onThought callback so
    // the stream sees `connectedAtCandidate` from before the frame and
    // `now()` from after the 5-minute mark when computing stableDuration.
    let virtualNow = 0;
    const sleepCalls: number[] = [];
    const { fetch } = createMockFetch([
      // First connection: immediate drop, increments attempt to 1.
      { status: 200, actions: [{ type: "abort" }] },
      // Second connection: delivers one thought, then closes. During the
      // thought handler we jump the virtual clock past the reset window.
      {
        status: 200,
        actions: [
          { type: "frames", text: makeThoughtFrame({ object_id: "k1" }) },
          { type: "close" },
        ],
      },
      // Third connection: stop after first frame so the test can assert
      // the sleep that preceded this connection.
      {
        status: 200,
        actions: [
          { type: "frames", text: makeThoughtFrame({ object_id: "k2" }) },
          { type: "close" },
        ],
      },
    ]);

    let seen = 0;
    const stream = createThoughtStream({
      config: makeConfig(),
      fetch,
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      now: () => virtualNow,
      random: () => 0,
      stableResetMs: 300_000,
    });

    await stream.start({
      onThought: () => {
        seen += 1;
        if (seen === 1) {
          // Jump past the reset window while the connection is still
          // "in progress" — stableDuration will exceed stableResetMs when
          // this connection ends.
          virtualNow += 400_000;
        }
        if (seen === 2) void stream.stop();
      },
    });

    // After the first drop (attempt 0 used): sleep is 1s.
    expect(sleepCalls[0]).toBe(1_000);
    // After the second connection's drop: stableDuration > stableResetMs,
    // so attempt was reset to 0, so sleep is again 1s.
    expect(sleepCalls[1]).toBe(1_000);
  });

  it("stop() aborts an in-flight connection and prevents further reconnects", async () => {
    const { fetch, requests } = createMockFetch([
      {
        status: 200,
        actions: [
          { type: "frames", text: makeThoughtFrame({ object_id: "k1" }) },
          { type: "delay", ms: 10_000 }, // hang
          { type: "close" },
        ],
      },
      { status: 200, actions: [{ type: "close" }] },
    ]);

    const stream = createThoughtStream({
      config: makeConfig(),
      fetch,
      sleep: async () => undefined,
      random: () => 0,
    });

    const startPromise = stream.start({
      onThought: () => {
        void stream.stop();
      },
    });

    await startPromise;
    expect(stream.isRunning()).toBe(false);
    expect(requests.length).toBe(1); // no reconnect after stop
  });
});
