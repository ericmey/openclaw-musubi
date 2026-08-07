import { describe, expect, it } from "vitest";

import type { MusubiConfig } from "../../src/config.js";
import { MusubiClient } from "../../src/musubi/client.js";
import type { FetchLike } from "../../src/musubi/types.js";
import { createSearchTool } from "../../src/tools/search.js";

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

describe("createSearchTool — canonical musubi_search", () => {
  it("registers as the canonical name musubi_search", () => {
    const { fetch } = createMockFetch([{ status: 200, body: { results: [] } }]);
    const tool = createSearchTool({ client: makeClient(fetch), config: makeConfig() });
    expect(tool.recommendedOptional).toBe(true);
    expect(tool.definition.name).toBe("musubi_search");
  });

  it("invokes /v1/retrieve with mode=deep and the caller's query", async () => {
    const { fetch, calls } = createMockFetch([{ status: 200, body: { results: [] } }]);
    const tool = createSearchTool({ client: makeClient(fetch), config: makeConfig() });

    await tool.definition.execute("call-1", { query: "find the thing" });

    expect(calls[0]?.url).toBe("https://musubi.test/v1/retrieve");
    const body = JSON.parse(calls[0]!.body!);
    expect(body.mode).toBe("deep");
    expect(body.query_text).toBe("find the thing");
    expect(body.state_filter).toEqual(["provisional", "matured", "promoted"]);
  });

  it("respects the planes filter when caller restricts", async () => {
    const { fetch, calls } = createMockFetch([{ status: 200, body: { results: [] } }]);
    const tool = createSearchTool({ client: makeClient(fetch), config: makeConfig() });

    await tool.definition.execute("c1", { query: "x", planes: ["curated"], limit: 3 });
    for (const call of calls) {
      const body = JSON.parse(call.body!);
      expect(body.planes).toEqual(["curated"]);
      expect(body.limit).toBe(3);
    }
  });

  it("renders results with [plane], score, and content", async () => {
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
    const tool = createSearchTool({ client: makeClient(fetch), config: makeConfig() });

    const result = await tool.definition.execute("call", { query: "preference" });

    expect(result.isError).toBeFalsy();
    const text = result.content[0]!.text;
    expect(text).toContain("[curated]");
    expect(text).toContain("0.88");
    expect(text).toContain("Eric prefers TypeScript.");
  });

  it("surfaces backend error as a tool error string", async () => {
    const { fetch } = createMockFetch([{ throw: new TypeError("fetch failed") }]);
    const tool = createSearchTool({ client: makeClient(fetch), config: makeConfig() });

    const result = await tool.definition.execute("call", { query: "x" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Musubi search failed");
  });

  it("returns a clear no-results message when the query matches nothing", async () => {
    const { fetch } = createMockFetch([{ status: 200, body: { results: [] } }]);
    const tool = createSearchTool({ client: makeClient(fetch), config: makeConfig() });

    const result = await tool.definition.execute("c", { query: "nothing matches" });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toContain("No Musubi results");
  });

  it("never launders a degraded retrieval envelope into an ordinary empty result", async () => {
    const { fetch } = createMockFetch([
      { status: 200, body: { results: [], warnings: ["one plane timed out"] } },
    ]);
    const tool = createSearchTool({ client: makeClient(fetch), config: makeConfig() });

    const result = await tool.definition.execute("c", { query: "missing" });

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toContain("retrieval was degraded");
    expect(result.content[0]?.text).toContain("one plane timed out");
    expect(result.content[0]?.text).not.toContain('No Musubi results for "missing"');
  });
});
