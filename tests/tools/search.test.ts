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

describe("recall contract — dates and the weak-match floor", () => {
  const row = (score: number, id = "obj1") => ({
    object_id: id,
    score,
    plane: "episodic",
    content: "some remembered content",
    namespace: "mizuki/hw-7ds/episodic",
  });

  it("renders each result's REAL source date, fetched per candidate", async () => {
    // /v1/retrieve carries no date (verified against the live API 2026-08-07),
    // so the date must be fetched. THIS is the field whose absence let a
    // wrong-week memory look like an answer.
    const { fetch, calls } = createMockFetch([
      { status: 200, body: { results: [row(0.81)] } },
      { status: 200, body: { object_id: "obj1", created_at: "2026-07-23T21:24:56Z" } },
    ]);
    const tool = createSearchTool({ client: makeClient(fetch), config: makeConfig() });
    const out = await tool.definition.execute("c", { query: "what did we decide" });
    const text = out.content[0]!.text;

    expect(text).toContain("2026-07-23");
    expect(calls[1]?.url).toBe(
      "https://musubi.test/v1/episodic/obj1?namespace=mizuki%2Fhw-7ds%2Fepisodic",
    );
  });

  it("prefers source created_at over ingestion event_at when both are present", async () => {
    const { fetch } = createMockFetch([
      { status: 200, body: { results: [row(0.81)] } },
      {
        status: 200,
        body: { created_at: "2026-07-23T00:00:00Z", event_at: "2026-08-07T00:00:00Z" },
      },
    ]);
    const tool = createSearchTool({ client: makeClient(fetch), config: makeConfig() });
    const text = (await tool.definition.execute("c", { query: "q" })).content[0]!.text;
    expect(text).toContain("2026-07-23");
    expect(text).not.toContain("2026-08-07");
  });

  it("falls back to event_at when source created_at is unavailable", async () => {
    const { fetch } = createMockFetch([
      { status: 200, body: { results: [row(0.81)] } },
      { status: 200, body: { event_at: "2026-07-23T00:00:00Z" } },
    ]);
    const tool = createSearchTool({ client: makeClient(fetch), config: makeConfig() });
    const text = (await tool.definition.execute("c", { query: "q" })).content[0]!.text;
    expect(text).toContain("2026-07-23");
  });

  it("degrades honestly when the date fetch fails — never guesses, never omits", async () => {
    const { fetch } = createMockFetch([
      { status: 200, body: { results: [row(0.81)] } },
      { throw: new Error("metadata fetch failed") },
    ]);
    const tool = createSearchTool({ client: makeClient(fetch), config: makeConfig() });
    const text = (await tool.definition.execute("c", { query: "q" })).content[0]!.text;
    expect(text).toContain("date unavailable");
    expect(text).toContain("some remembered content");
    expect(text).toContain("Retrieval warnings:");
    expect(text).toContain("date metadata unavailable for episodic");
  });

  it("SUPPRESSES content below the floor — 0.59 is withheld", async () => {
    // The provisional floor is intentionally conservative; clean-corpus
    // known-answer calibration remains pending.
    const { fetch } = createMockFetch([
      { status: 200, body: { results: [row(0.59), row(0.5, "obj2")] } },
    ]);
    const tool = createSearchTool({ client: makeClient(fetch), config: makeConfig() });
    const text = (await tool.definition.execute("c", { query: "yesterday" })).content[0]!.text;

    expect(text).toContain("NO STRONG MATCH");
    expect(text).toContain("0.59");
    expect(text).not.toContain("some remembered content");
  });

  it("renders at exactly the floor — 0.60 is shown", async () => {
    const { fetch } = createMockFetch([
      { status: 200, body: { results: [row(0.6)] } },
      { status: 200, body: { created_at: "2026-07-25T10:00:00Z" } },
    ]);
    const tool = createSearchTool({ client: makeClient(fetch), config: makeConfig() });
    const text = (await tool.definition.execute("c", { query: "q" })).content[0]!.text;
    expect(text).not.toContain("NO STRONG MATCH");
    expect(text).toContain("some remembered content");
    expect(text).toContain("2026-07-25");
  });

  it("does not fetch dates at all when the floor suppresses the result", async () => {
    const { fetch, calls } = createMockFetch([{ status: 200, body: { results: [row(0.31)] } }]);
    const tool = createSearchTool({ client: makeClient(fetch), config: makeConfig() });
    await tool.definition.execute("c", { query: "q" });
    expect(calls).toHaveLength(1);
  });
});
