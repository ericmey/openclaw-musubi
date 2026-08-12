import { describe, expect, it } from "vitest";
import type { MusubiConfig } from "../../src/config.js";
import { MusubiClient } from "../../src/musubi/client.js";
import type { FetchLike } from "../../src/musubi/types.js";
import { createRecallTool } from "../../src/tools/recall.js";

function makeConfig(overrides: Partial<MusubiConfig> = {}): MusubiConfig {
  return {
    core: { baseUrl: "https://musubi.test", token: "t", ...(overrides.core ?? {}) },
    presence: { defaultId: "eric/openclaw", ...(overrides.presence ?? {}) },
  };
}

type ScriptedResponse = { status: number; body?: unknown } | { throw: Error };

function createMockFetch(script: ScriptedResponse[]) {
  const calls: Array<{ url: string; body: string | undefined }> = [];
  let cursor = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, body: typeof init.body === "string" ? init.body : undefined });
    const def = script[cursor] ?? script[script.length - 1];
    cursor += 1;
    if (def === undefined) throw new Error("script exhausted");
    if ("throw" in def) throw def.throw;
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
    generateIdempotencyKey: () => "i",
    retry: { maxAttempts: 1 },
  });
}

describe("createRecallTool", () => {
  it("test_recall_registered_as_optional_tool_not_required", () => {
    const { fetch } = createMockFetch([{ status: 200, body: { results: [] } }]);
    const tool = createRecallTool({ client: makeClient(fetch), config: makeConfig() });
    expect(tool.recommendedOptional).toBe(true);
    expect(tool.definition.name).toBe("musubi_recall");
  });

  it("test_recall_queries_retrieve_with_deep_mode", async () => {
    const { fetch, calls } = createMockFetch([{ status: 200, body: { results: [] } }]);
    const tool = createRecallTool({ client: makeClient(fetch), config: makeConfig() });

    await tool.definition.execute("call-1", { query: "find the thing" });

    expect(calls[0]?.url).toBe("https://musubi.test/v1/retrieve");
    const body = JSON.parse(calls[0]!.body!);
    expect(body.mode).toBe("deep");
    expect(body.query_text).toBe("find the thing");
  });

  it("test_recall_accepts_plane_filter_and_limit_parameters", async () => {
    // Recall omits `namespace` so the server's family-discovery path
    // enumerates the caller's identity family and FILTERS unauthorized
    // namespaces. The previous `<owner>/*` wildcard (ADR 0031) ran the
    // strict-authorization path: one out-of-scope stored namespace
    // 403ed the entire retrieve.
    const { fetch, calls } = createMockFetch([{ status: 200, body: { results: [] } }]);
    const tool = createRecallTool({ client: makeClient(fetch), config: makeConfig() });

    await tool.definition.execute("c1", { query: "x", planes: ["curated"], limit: 3 });
    const curatedOnly = calls.splice(0, calls.length);
    expect(curatedOnly.length).toBeGreaterThan(0);
    for (const call of curatedOnly) {
      const body = JSON.parse(call.body!);
      expect(body.planes).toEqual(["curated"]);
      expect(body.limit).toBe(3);
      expect(body).not.toHaveProperty("namespace");
    }

    await tool.definition.execute("c2", { query: "x" });
    const defaultFanout = calls;
    expect(defaultFanout.length).toBeGreaterThan(0);
    for (const call of defaultFanout) {
      const body = JSON.parse(call.body!);
      expect(body).not.toHaveProperty("namespace");
      expect(body.planes.length).toBeGreaterThanOrEqual(1);
      expect(body.limit).toBe(10);
    }
  });

  it("test_recall_returns_shaped_content_for_agent_consumption", async () => {
    const { fetch } = createMockFetch([
      {
        status: 200,
        body: {
          results: [
            {
              object_id: "k-1",
              score: 0.88,
              plane: "curated",
              content: "Eric prefers TypeScript.",
              namespace: "eric/_shared/curated",
            },
          ],
        },
      },
    ]);
    const tool = createRecallTool({ client: makeClient(fetch), config: makeConfig() });

    const result = await tool.definition.execute("call", { query: "preference" });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.type).toBe("text");
    const text = result.content[0]!.text;
    expect(text).toContain("[curated]");
    expect(text).toContain("0.88");
    expect(text).toContain("Eric prefers TypeScript.");
  });

  it("test_recall_maps_core_unreachable_to_agent_visible_error", async () => {
    const { fetch } = createMockFetch([{ throw: new TypeError("fetch failed") }]);
    const tool = createRecallTool({ client: makeClient(fetch), config: makeConfig() });

    const result = await tool.definition.execute("call", { query: "x" });

    expect(result.isError).toBe(true);
    // After ADR 0032, `musubi_recall` is a deprecation alias forwarding to
    // the canonical `musubi_search` body — the user-facing error message
    // is the canonical one.
    expect(result.content[0]?.text).toContain("Musubi search failed");
  });

  it("uses agent presence when agentId is provided", async () => {
    const { fetch, calls } = createMockFetch([{ status: 200, body: { results: [] } }]);
    const tool = createRecallTool({
      client: makeClient(fetch),
      config: makeConfig({
        presence: { defaultId: "eric/openclaw", perAgent: { aoi: "eric/aoi" } },
      }),
      agentId: "aoi",
    });

    await tool.definition.execute("c", { query: "x" });

    // Recall omits `namespace` regardless of which presence the agent
    // maps to: the server derives the identity family from the TOKEN's
    // presence and enumerates `eric/aoi/*` AND `eric/_shared/*` itself,
    // filtering (not rejecting) anything the token cannot read.
    for (const call of calls) {
      expect(JSON.parse(call.body!)).not.toHaveProperty("namespace");
    }
  });

  it("returns friendly message on zero results", async () => {
    const { fetch } = createMockFetch([{ status: 200, body: { results: [] } }]);
    const tool = createRecallTool({ client: makeClient(fetch), config: makeConfig() });

    const result = await tool.definition.execute("c", { query: "nothing matches" });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toContain("No Musubi results");
  });

  it("logs a deprecation warning on every invocation", async () => {
    // After ADR 0032, `musubi_recall` is a one-release deprecation alias
    // for `musubi_search`. Each call must log a warning so prompts /
    // operators see the migration signal.
    const { fetch } = createMockFetch([{ status: 200, body: { results: [] } }]);
    const warnings: string[] = [];
    const tool = createRecallTool({
      client: makeClient(fetch),
      config: makeConfig(),
      logger: { warn: (msg) => warnings.push(msg) },
    });

    await tool.definition.execute("c", { query: "x" });
    await tool.definition.execute("c", { query: "y" });

    expect(warnings).toHaveLength(2);
    for (const warning of warnings) {
      expect(warning.toLowerCase()).toContain("deprecated");
      expect(warning).toMatch(/musubi_recall|musubi_search/);
    }
  });
});
