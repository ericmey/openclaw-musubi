import { describe, expect, it } from "vitest";

import type { MusubiConfig } from "../../src/config.js";
import { MusubiClient } from "../../src/musubi/client.js";
import type { FetchLike } from "../../src/musubi/types.js";
import { createRecentTool } from "../../src/tools/recent.js";

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

describe("createRecentTool", () => {
  const EPOCH_2026_09_19 = Date.parse("2026-09-19T00:00:00Z") / 1000;
  const EPOCH_2026_09_01 = Date.parse("2026-09-01T00:00:00Z") / 1000;

  const recent = (rows: unknown[], warnings: unknown[] = []) => ({
    status: 200,
    body: { mode: "recent", limit: 10, warnings, results: rows },
  });

  const row = (id: string, epoch: number, extra: Record<string, unknown> = {}) => ({
    object_id: id,
    namespace: "eric/openclaw/episodic",
    plane: "episodic",
    score: epoch,
    score_kind: "created_epoch",
    content: `content-${id}`,
    state: "provisional",
    importance: 5,
    provenance_score: null,
    extra: { score_components: {}, lineage: {} },
    ...extra,
  });

  const bodyOf = (calls: Array<{ body: string | undefined }>) =>
    JSON.parse(calls[0]?.body ?? "{}") as Record<string, unknown>;

  it("registers as musubi_recent", () => {
    const { fetch } = createMockFetch([recent([])]);
    const tool = createRecentTool({ client: makeClient(fetch), config: makeConfig() });
    expect(tool.definition.name).toBe("musubi_recent");
    expect(tool.recommendedOptional).toBe(true);
  });

  it("calls POST /v1/retrieve in recent mode for the presence's episodic namespace", async () => {
    const { fetch, calls } = createMockFetch([recent([])]);
    const tool = createRecentTool({ client: makeClient(fetch), config: makeConfig() });

    await tool.definition.execute("call", { limit: 5 });

    expect(calls[0]?.url).toBe("https://musubi.test/v1/retrieve");
    expect(bodyOf(calls)).toMatchObject({
      namespace: "eric/openclaw/episodic",
      planes: ["episodic"],
      mode: "recent",
      limit: 5,
      state_filter: ["provisional", "matured", "promoted"],
    });
  });

  it("pushes the tag filter to the server rather than filtering a page in process", async () => {
    const { fetch, calls } = createMockFetch([recent([])]);
    const tool = createRecentTool({ client: makeClient(fetch), config: makeConfig() });

    await tool.definition.execute("c", { tags: ["src:openclaw-agent-remember", "important"] });

    // Server-side AND semantics across the whole namespace. Filtering a
    // scroll-ordered page client-side could miss matches that were simply
    // not on the page — a memory tool must not report a false absence.
    expect(bodyOf(calls).tags).toEqual(["src:openclaw-agent-remember", "important"]);
  });

  it("converts `since` to epoch seconds because the server rejects ISO strings", async () => {
    const { fetch, calls } = createMockFetch([recent([])]);
    const tool = createRecentTool({ client: makeClient(fetch), config: makeConfig() });

    await tool.definition.execute("c", { since: "2026-09-19T00:00:00Z" });

    expect(bodyOf(calls).since).toBe(EPOCH_2026_09_19);
  });

  it("omits tags and since entirely when absent", async () => {
    const { fetch, calls } = createMockFetch([recent([])]);
    const tool = createRecentTool({ client: makeClient(fetch), config: makeConfig() });

    await tool.definition.execute("c", {});

    const sent = bodyOf(calls);
    expect(sent).not.toHaveProperty("tags");
    expect(sent).not.toHaveProperty("since");
  });

  it("rejects an invalid `since` value with a clear tool error", async () => {
    const { fetch, calls } = createMockFetch([recent([])]);
    const tool = createRecentTool({ client: makeClient(fetch), config: makeConfig() });

    const result = await tool.definition.execute("c", { since: "not-a-date" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Invalid 'since'");
    expect(calls).toHaveLength(0);
  });

  it("orders newest-first and renders the date from created_epoch", async () => {
    const { fetch } = createMockFetch([
      recent([row("older", EPOCH_2026_09_01), row("newer", EPOCH_2026_09_19)]),
    ]);
    const tool = createRecentTool({ client: makeClient(fetch), config: makeConfig() });

    const text = (await tool.definition.execute("c", {})).content[0]?.text ?? "";

    // Recent rows carry score_kind "created_epoch", so `score` IS the source
    // timestamp — no per-row date enrichment needed.
    expect(text).toContain("2026-09-19T00:00:00.000Z");
    expect(text.indexOf("content-newer")).toBeLessThan(text.indexOf("content-older"));
  });

  it("flags server-truncated content instead of rendering a slice as the whole row", async () => {
    const { fetch } = createMockFetch([
      recent([row("big", EPOCH_2026_09_19, { content_truncated: true, content_length: 9001 })]),
    ]);
    const tool = createRecentTool({ client: makeClient(fetch), config: makeConfig() });

    const text = (await tool.definition.execute("c", {})).content[0]?.text ?? "";

    expect(text).toContain("content truncated of 9001 chars");
    expect(text).toContain("musubi_get");
  });

  it("surfaces a degraded envelope's warnings", async () => {
    const { fetch } = createMockFetch([recent([row("a", EPOCH_2026_09_19)], ["partial_scan"])]);
    const tool = createRecentTool({ client: makeClient(fetch), config: makeConfig() });

    const text = (await tool.definition.execute("c", {})).content[0]?.text ?? "";

    expect(text).toContain("Retrieval warnings:");
    expect(text).toContain("partial_scan");
  });

  it("fails closed on a row from outside the requested namespace", async () => {
    const { fetch } = createMockFetch([
      recent([{ ...row("x", EPOCH_2026_09_19), namespace: "someone-else/rin/episodic" }]),
    ]);
    const tool = createRecentTool({ client: makeClient(fetch), config: makeConfig() });

    const result = await tool.definition.execute("c", {});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("identity boundary violation");
    expect(result.content[0]?.text).not.toContain("content-x");
  });

  it("rejects a malformed warnings field instead of throwing from it", async () => {
    const { fetch } = createMockFetch([
      { status: 200, body: { mode: "recent", limit: 10, warnings: {}, results: [] } },
    ]);
    const tool = createRecentTool({ client: makeClient(fetch), config: makeConfig() });

    // Previously this passed the envelope gate and then threw a TypeError out
    // of execute() from `.map()`, rather than returning a tool error.
    const result = await tool.definition.execute("c", {});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("unexpected envelope");
  });

  it("rejects an envelope that is not a recent-mode response", async () => {
    const { fetch } = createMockFetch([
      { status: 200, body: { mode: "deep", limit: 10, warnings: [], results: [] } },
    ]);
    const tool = createRecentTool({ client: makeClient(fetch), config: makeConfig() });

    const result = await tool.definition.execute("c", {});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("unexpected envelope");
  });

  it("returns a friendly empty-namespace message when no rows match", async () => {
    const { fetch } = createMockFetch([recent([])]);
    const tool = createRecentTool({ client: makeClient(fetch), config: makeConfig() });

    const result = await tool.definition.execute("c", {});

    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe("No recent activity in eric/openclaw/episodic.");
  });

  it("surfaces a transport failure as a tool error", async () => {
    const { fetch } = createMockFetch([{ status: 503, body: { detail: "down" } }]);
    const tool = createRecentTool({ client: makeClient(fetch), config: makeConfig() });

    const result = await tool.definition.execute("c", {});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Musubi recent failed");
  });

  it("uses agent presence when agentId is provided", async () => {
    const { fetch, calls } = createMockFetch([recent([])]);
    const tool = createRecentTool({
      client: makeClient(fetch),
      config: makeConfig({
        presence: { defaultId: "eric/openclaw", perAgent: { aoi: "eric/aoi" } },
      }),
      agentId: "aoi",
    });

    await tool.definition.execute("c", {});
    expect(bodyOf(calls).namespace).toBe("eric/aoi/episodic");
  });
});
