import { describe, it, expect } from "vitest";
import { MusubiClient } from "../../src/musubi/client.js";
import { createGetTool } from "../../src/tools/get.js";
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
    generateIdempotencyKey: () => "auto-idem",
    retry: { maxAttempts: 1 },
  });
}

describe("createGetTool", () => {
  it("test_get_routes_episodic_to_v1_episodic", async () => {
    const { fetch, calls } = createMockFetch([
      {
        status: 200,
        body: {
          object_id: "ep-1",
          namespace: "eric/aoi-phone/episodic",
          content: "Eric called from the car.",
          event_at: "2026-04-29T18:00:00Z",
          importance: 7,
          topics: ["car", "phone"],
        },
      },
    ]);
    const tool = createGetTool({ client: makeClient(fetch), config: makeConfig() });

    const result = await tool.definition.execute("call-1", {
      plane: "episodic",
      namespace: "eric/aoi-phone/episodic",
      object_id: "ep-1",
    });

    expect(calls[0]?.url).toBe(
      "https://musubi.test/v1/episodic/ep-1?namespace=eric%2Faoi-phone%2Fepisodic",
    );
    expect(result.isError).toBeUndefined();
    const text = result.content[0]!.text;
    expect(text).toContain("[episodic] eric/aoi-phone/episodic/ep-1");
    expect(text).toContain("Eric called from the car.");
    expect(text).toContain("importance: 7");
    expect(text).toContain("event_at: 2026-04-29T18:00:00Z");
    expect(text).toContain("topics: car, phone");
  });

  it("test_get_routes_each_plane_to_its_pluralization", async () => {
    const planes = [
      { plane: "curated", path: "/v1/curated/" },
      { plane: "concept", path: "/v1/concepts/" },
      { plane: "episodic", path: "/v1/episodic/" },
      { plane: "artifact", path: "/v1/artifacts/" },
    ] as const;

    for (const { plane, path } of planes) {
      const { fetch, calls } = createMockFetch([
        { status: 200, body: { object_id: "x", content: "ok" } },
      ]);
      const tool = createGetTool({ client: makeClient(fetch), config: makeConfig() });
      await tool.definition.execute("c", {
        plane,
        namespace: "eric/openclaw/episodic",
        object_id: "x",
      });
      expect(calls[0]?.url).toContain(`https://musubi.test${path}x?`);
    }
  });

  it("test_get_url_encodes_object_id", async () => {
    const { fetch, calls } = createMockFetch([{ status: 200, body: { content: "ok" } }]);
    const tool = createGetTool({ client: makeClient(fetch), config: makeConfig() });

    await tool.definition.execute("c", {
      plane: "curated",
      namespace: "eric/_shared/curated",
      object_id: "path/with slash & space",
    });

    expect(calls[0]?.url).toBe(
      "https://musubi.test/v1/curated/path%2Fwith%20slash%20%26%20space?namespace=eric%2F_shared%2Fcurated",
    );
  });

  it("test_get_uses_per_agent_token_for_presence", async () => {
    const { fetch, calls } = createMockFetch([{ status: 200, body: { content: "ok" } }]);
    const tool = createGetTool({
      client: makeClient(fetch),
      config: makeConfig({
        core: {
          baseUrl: "https://musubi.test",
          token: "default-token",
          perAgentTokens: { aoi: "aoi-token" },
        },
        presence: { defaultId: "eric/openclaw", perAgent: { aoi: "eric/aoi" } },
      }),
      agentId: "aoi",
    });

    await tool.definition.execute("c", {
      plane: "episodic",
      namespace: "eric/aoi/episodic",
      object_id: "ep-1",
    });

    expect(calls[0]?.headers["Authorization"]).toBe("Bearer aoi-token");
  });

  it("test_get_404_returns_tool_error_with_clear_message", async () => {
    const { fetch } = createMockFetch([{ status: 404, body: { detail: "not found" } }]);
    const tool = createGetTool({ client: makeClient(fetch), config: makeConfig() });

    const result = await tool.definition.execute("c", {
      plane: "episodic",
      namespace: "eric/openclaw/episodic",
      object_id: "missing",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("no episodic object missing");
    expect(result.content[0]?.text).toContain("eric/openclaw/episodic");
  });

  it("test_get_5xx_returns_generic_tool_error", async () => {
    const { fetch } = createMockFetch([{ status: 500, body: { error: "boom" } }]);
    const tool = createGetTool({ client: makeClient(fetch), config: makeConfig() });

    const result = await tool.definition.execute("c", {
      plane: "episodic",
      namespace: "eric/openclaw/episodic",
      object_id: "x",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Musubi get failed");
  });

  it("test_get_renders_curated_specific_fields", async () => {
    const { fetch } = createMockFetch([
      {
        status: 200,
        body: {
          object_id: "cur-1",
          title: "Aoi voice & temperament",
          state: "matured",
          vault_path: "world/identity/aoi.md",
          topics: ["aoi", "voice"],
          body: "She is the quiet fire.",
        },
      },
    ]);
    const tool = createGetTool({ client: makeClient(fetch), config: makeConfig() });

    const result = await tool.definition.execute("c", {
      plane: "curated",
      namespace: "eric/_shared/curated",
      object_id: "cur-1",
    });

    const text = result.content[0]!.text;
    expect(text).toContain("title: Aoi voice & temperament");
    expect(text).toContain("vault_path: world/identity/aoi.md");
    expect(text).toContain("state: matured");
    // body falls back to content when `content` is absent
    expect(text).toContain("She is the quiet fire.");
  });

  it("test_get_falls_back_to_summary_when_no_body_or_content", async () => {
    const { fetch } = createMockFetch([
      { status: 200, body: { object_id: "x", summary: "Short summary." } },
    ]);
    const tool = createGetTool({ client: makeClient(fetch), config: makeConfig() });

    const result = await tool.definition.execute("c", {
      plane: "concept",
      namespace: "eric/_shared/concept",
      object_id: "x",
    });

    expect(result.content[0]!.text).toContain("Short summary.");
  });

  it("test_get_omits_namespace_and_object_id_keys_from_metadata_block", async () => {
    // Header line already prints `[plane] namespace/object_id` — no need
    // to repeat them in the metadata key list.
    const { fetch } = createMockFetch([
      {
        status: 200,
        body: {
          object_id: "ep-1",
          namespace: "eric/aoi-phone/episodic",
          content: "x",
          importance: 5,
        },
      },
    ]);
    const tool = createGetTool({ client: makeClient(fetch), config: makeConfig() });

    const result = await tool.definition.execute("c", {
      plane: "episodic",
      namespace: "eric/aoi-phone/episodic",
      object_id: "ep-1",
    });

    const text = result.content[0]!.text;
    // Header line is fine.
    expect(text.startsWith("[episodic] eric/aoi-phone/episodic/ep-1")).toBe(true);
    // But no `namespace: ...` or `object_id: ...` rendered as metadata rows.
    expect(text).not.toMatch(/^namespace:/m);
    expect(text).not.toMatch(/^object_id:/m);
  });

  it("test_get_presence_resolution_failure_is_tool_error", async () => {
    // Strict-mode-like failure: agent has presence mapping but no token.
    const { fetch } = createMockFetch([{ status: 200, body: {} }]);
    const tool = createGetTool({
      client: makeClient(fetch),
      config: makeConfig({
        core: { baseUrl: "https://musubi.test", token: "" },
        presence: { defaultId: "eric/openclaw" },
      }),
    });

    const result = await tool.definition.execute("c", {
      plane: "episodic",
      namespace: "eric/openclaw/episodic",
      object_id: "x",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Presence unresolved");
  });
});
