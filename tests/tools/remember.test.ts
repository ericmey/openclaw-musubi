import { describe, it, expect } from "vitest";
import { MusubiClient } from "../../src/musubi/client.js";
import { createRememberTool } from "../../src/tools/remember.js";
import type { MusubiConfig } from "../../src/config.js";
import type { FetchLike } from "../../src/musubi/types.js";

function makeConfig(overrides: Partial<MusubiConfig> = {}): MusubiConfig {
  return {
    core: { baseUrl: "https://musubi.test", token: "t", ...(overrides.core ?? {}) },
    presence: { defaultId: "eric/openclaw", ...(overrides.presence ?? {}) },
  };
}

function createMockFetch(script: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string | undefined }> =
    [];
  let cursor = 0;
  const fetch: FetchLike = async (url, init) => {
    const headers: Record<string, string> = {};
    if (init.headers) {
      for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
        headers[k] = v;
      }
    }
    calls.push({ url, headers, body: typeof init.body === "string" ? init.body : undefined });
    const def = script[cursor] ?? script[script.length - 1];
    cursor += 1;
    if (def === undefined) throw new Error("script exhausted");
    return new Response(def.body !== undefined ? JSON.stringify(def.body) : null, {
      status: def.status,
      headers: { "content-type": "application/json" },
    });
  };
  return { fetch, calls };
}

function makeClient(fetch: FetchLike) {
  return new MusubiClient({
    baseUrl: "https://musubi.test",
    token: "t",
    fetch,
    sleep: async () => undefined,
    random: () => 0,
    generateRequestId: () => "r",
    // A distinct auto-generated key per POST so we can tell overrides apart.
    generateIdempotencyKey: () => "auto-idem",
    retry: { maxAttempts: 1 },
  });
}

const FIXED_NOW = () => new Date("2026-04-20T05:00:00.000Z");

describe("createRememberTool", () => {
  it("test_remember_accepts_content_importance_topics", async () => {
    const { fetch, calls } = createMockFetch([{ status: 200, body: { object_id: "stored-1" } }]);
    const tool = createRememberTool({
      client: makeClient(fetch),
      config: makeConfig(),
      now: FIXED_NOW,
    });

    await tool.definition.execute("call-1", {
      content: "Eric said ship Musubi v2 this quarter.",
      importance: 9,
      topics: ["musubi", "roadmap"],
    });

    const body = JSON.parse(calls[0]!.body!);
    expect(body.content).toBe("Eric said ship Musubi v2 this quarter.");
    expect(body.importance).toBe(9);
    // `topics` is folded into `tags` at the canonical boundary so the
    // request matches `POST /v1/memories`'s CaptureRequest shape.
    expect(body.tags).toEqual(
      expect.arrayContaining([
        "musubi",
        "roadmap",
        "src:openclaw-agent-remember",
        "ref:call-1",
      ]),
    );
  });

  it("test_remember_posts_to_memories_with_presence_namespace", async () => {
    const { fetch, calls } = createMockFetch([{ status: 200, body: { object_id: "stored" } }]);
    const tool = createRememberTool({
      client: makeClient(fetch),
      config: makeConfig({
        presence: { defaultId: "eric/openclaw", perAgent: { aoi: "eric/aoi" } },
      }),
      agentId: "aoi",
      now: FIXED_NOW,
    });

    await tool.definition.execute("call", { content: "x" });

    expect(calls[0]?.url).toBe("https://musubi.test/v1/memories");
    const body = JSON.parse(calls[0]!.body!);
    expect(body.namespace).toBe("eric/aoi/episodic");
    // Canonical CaptureRequest has no `capture_source` — it lives in
    // `tags` as an `src:` prefix now.
    expect(body.tags).toContain("src:openclaw-agent-remember");
  });

  it("test_remember_idempotent_on_client_supplied_id", async () => {
    const { fetch, calls } = createMockFetch([{ status: 202 }, { status: 202 }, { status: 202 }]);
    const tool = createRememberTool({
      client: makeClient(fetch),
      config: makeConfig(),
      now: FIXED_NOW,
    });

    // Client-supplied idempotency key overrides the auto-derived one.
    await tool.definition.execute("call-1", { content: "x", idempotencyKey: "user-stable-id" });
    // No override → derived from tool-call id.
    await tool.definition.execute("call-2", { content: "x" });
    // Same client-supplied key again → same idempotency header.
    await tool.definition.execute("call-3", { content: "x", idempotencyKey: "user-stable-id" });

    expect(calls[0]?.headers["Idempotency-Key"]).toBe("user-stable-id");
    expect(calls[1]?.headers["Idempotency-Key"]).toBe("openclaw-remember:call-2");
    expect(calls[2]?.headers["Idempotency-Key"]).toBe("user-stable-id");
  });

  it("defaults importance to 7 (higher than passive capture's 5)", async () => {
    const { fetch, calls } = createMockFetch([{ status: 202 }]);
    const tool = createRememberTool({
      client: makeClient(fetch),
      config: makeConfig(),
      now: FIXED_NOW,
    });

    await tool.definition.execute("c", { content: "note" });

    expect(JSON.parse(calls[0]!.body!).importance).toBe(7);
  });

  it("surfaces errors as tool errors, not throws", async () => {
    const { fetch } = createMockFetch([{ status: 500, body: { error: "boom" } }]);
    const tool = createRememberTool({
      client: makeClient(fetch),
      config: makeConfig(),
      now: FIXED_NOW,
    });

    const result = await tool.definition.execute("c", { content: "note" });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Musubi remember failed");
  });
});
