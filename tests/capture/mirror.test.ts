import { describe, it, expect } from "vitest";
import { MusubiClient } from "../../src/musubi/client.js";
import { createCaptureMirror, type MirrorLogger } from "../../src/capture/mirror.js";
import type { MusubiConfig } from "../../src/config.js";
import type { FetchLike } from "../../src/musubi/types.js";

type RecordedCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
};

type ScriptedResponse =
  | { status: number; body?: unknown; headers?: Record<string, string> }
  | { throw: Error };

function createMockFetch(script: ScriptedResponse[]): {
  fetch: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let cursor = 0;
  const fetch: FetchLike = async (url, init) => {
    const headers: Record<string, string> = {};
    if (init.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k] = v;
      }
    }
    calls.push({
      url,
      method: init.method ?? "GET",
      headers,
      body: typeof init.body === "string" ? init.body : undefined,
    });
    const def = script[cursor] ?? script[script.length - 1];
    cursor += 1;
    if (def === undefined) throw new Error("script exhausted");
    if ("throw" in def) throw def.throw;
    return new Response(def.body !== undefined ? JSON.stringify(def.body) : null, {
      status: def.status,
      headers: { "content-type": "application/json", ...(def.headers ?? {}) },
    });
  };
  return { fetch, calls };
}

function makeConfig(overrides: Partial<MusubiConfig> = {}): MusubiConfig {
  return {
    core: { baseUrl: "https://musubi.test", token: "t", ...(overrides.core ?? {}) },
    presence: { defaultId: "eric/openclaw", ...(overrides.presence ?? {}) },
    ...(overrides.capture !== undefined ? { capture: overrides.capture } : {}),
  };
}

function makeClient(fetch: FetchLike) {
  return new MusubiClient({
    baseUrl: "https://musubi.test",
    token: "t",
    fetch,
    sleep: async () => undefined,
    random: () => 0,
    generateRequestId: () => "r",
    generateIdempotencyKey: () => "i",
    retry: { maxAttempts: 1 },
  });
}

function spyLogger(): MirrorLogger & {
  calls: Array<{ message: string; fields?: Record<string, unknown> }>;
} {
  const calls: Array<{ message: string; fields?: Record<string, unknown> }> = [];
  return {
    calls,
    warn(message, fields) {
      calls.push({ message, fields });
    },
  };
}

describe("createCaptureMirror", () => {
  it("test_mirror_registers_openclaw_memory_write_hook", () => {
    // The mirror module exposes the handlers the wiring slice will register
    // via api.on("agent_end", ...). This test asserts the handler surface
    // exists and is callable; integration with api.on is the wiring slice's
    // responsibility (per the slice issue claim comment).
    const { fetch } = createMockFetch([{ status: 202 }]);
    const mirror = createCaptureMirror({
      client: makeClient(fetch),
      config: makeConfig(),
    });

    expect(typeof mirror.handleEvent).toBe("function");
    expect(typeof mirror.handleBatch).toBe("function");
    expect(mirror.enabled).toBe(true);
  });

  it("test_mirror_posts_single_event_to_episodic_endpoint", async () => {
    const { fetch, calls } = createMockFetch([{ status: 202 }]);
    const mirror = createCaptureMirror({
      client: makeClient(fetch),
      config: makeConfig(),
    });

    await mirror.handleEvent({ id: "evt-1", content: "hello" });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://musubi.test/v1/memories");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers["Idempotency-Key"]).toBe("openclaw-mirror:evt-1");
    const body = JSON.parse(calls[0]!.body!);
    expect(body.namespace).toBe("eric/openclaw/episodic");
    expect(body.content).toBe("hello");
    // Audit metadata folds into `tags` with prefixes; canonical
    // CaptureRequest does not persist `source_ref` / `capture_source`
    // as first-class fields.
    expect(body.tags).toContain("ref:evt-1");
    expect(body.tags).toContain("src:openclaw-agent-end");
  });

  it("test_mirror_batches_events_when_openclaw_flushes_multiple", async () => {
    const { fetch, calls } = createMockFetch([{ status: 202 }]);
    const mirror = createCaptureMirror({
      client: makeClient(fetch),
      config: makeConfig(),
    });

    await mirror.handleBatch([
      { id: "evt-1", content: "first" },
      { id: "evt-2", content: "second" },
      { id: "evt-3", content: "third" },
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://musubi.test/v1/memories/batch");
    const body = JSON.parse(calls[0]!.body!);
    // Canonical batch shape: {namespace, items[]}. Each item carries
    // content/importance/tags — no per-item namespace or idempotency
    // key on the wire.
    expect(body.namespace).toBe("eric/openclaw/episodic");
    expect(body.items).toHaveLength(3);
    expect(body.items[0].content).toBe("first");
    expect(calls[0]?.headers["Idempotency-Key"]).toBe(
      "batch:openclaw-mirror:evt-1,openclaw-mirror:evt-2,openclaw-mirror:evt-3",
    );
  });

  it("test_mirror_does_not_block_openclaw_write_on_musubi_failure", async () => {
    const { fetch } = createMockFetch([{ throw: new TypeError("network down") }]);
    const logger = spyLogger();
    const mirror = createCaptureMirror({
      client: makeClient(fetch),
      config: makeConfig(),
      logger,
    });

    // Must not throw — OpenClaw caller awaits this and expects no exception.
    await expect(mirror.handleEvent({ id: "evt-1", content: "x" })).resolves.toBeUndefined();
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]?.message).toContain("mirror handleEvent failed");
  });

  it("test_mirror_logs_but_does_not_throw_on_auth_error", async () => {
    const { fetch } = createMockFetch([{ status: 401 }]);
    const logger = spyLogger();
    const mirror = createCaptureMirror({
      client: makeClient(fetch),
      config: makeConfig(),
      logger,
    });

    await expect(mirror.handleEvent({ id: "evt-1", content: "x" })).resolves.toBeUndefined();
    expect(logger.calls).toHaveLength(1);
    expect(logger.calls[0]?.fields?.error).toContain("401");
  });

  it("test_mirror_carries_agent_presence_through_to_namespace", async () => {
    const { fetch, calls } = createMockFetch([{ status: 202 }]);
    const mirror = createCaptureMirror({
      client: makeClient(fetch),
      config: makeConfig({
        presence: { defaultId: "eric/openclaw", perAgent: { aoi: "eric/aoi" } },
      }),
    });

    await mirror.handleEvent({ id: "evt-1", content: "x", agentId: "aoi" });

    const body = JSON.parse(calls[0]!.body!);
    expect(body.namespace).toBe("eric/aoi/episodic");
  });

  it("test_mirror_is_disabled_when_config_mirrorOpenClawMemory_is_false", async () => {
    const { fetch, calls } = createMockFetch([{ status: 202 }]);
    const mirror = createCaptureMirror({
      client: makeClient(fetch),
      config: makeConfig({ capture: { mirrorOpenClawMemory: false } }),
    });

    expect(mirror.enabled).toBe(false);
    await mirror.handleEvent({ id: "evt-1", content: "x" });
    await mirror.handleBatch([{ id: "evt-2", content: "y" }]);

    expect(calls).toEqual([]);
  });

  it("test_mirror_idempotency_key_is_stable_per_source_memory_id", async () => {
    const { fetch, calls } = createMockFetch([{ status: 202 }, { status: 202 }]);
    const mirror = createCaptureMirror({
      client: makeClient(fetch),
      config: makeConfig(),
    });

    await mirror.handleEvent({ id: "stable-evt", content: "first" });
    await mirror.handleEvent({ id: "stable-evt", content: "second" });

    expect(calls[0]?.headers["Idempotency-Key"]).toBe("openclaw-mirror:stable-evt");
    expect(calls[1]?.headers["Idempotency-Key"]).toBe("openclaw-mirror:stable-evt");
  });

  it("skips events with empty content", async () => {
    const { fetch, calls } = createMockFetch([{ status: 202 }]);
    const mirror = createCaptureMirror({
      client: makeClient(fetch),
      config: makeConfig(),
    });

    await mirror.handleEvent({ id: "evt-1", content: "" });
    expect(calls).toEqual([]);
  });
});
