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
  it("registers as musubi_recent", () => {
    const { fetch } = createMockFetch([{ status: 200, body: { items: [] } }]);
    const tool = createRecentTool({ client: makeClient(fetch), config: makeConfig() });
    expect(tool.definition.name).toBe("musubi_recent");
    expect(tool.recommendedOptional).toBe(true);
  });

  it("calls GET /v1/episodic with the presence's episodic namespace", async () => {
    const { fetch, calls } = createMockFetch([{ status: 200, body: { items: [] } }]);
    const tool = createRecentTool({ client: makeClient(fetch), config: makeConfig() });

    await tool.definition.execute("call", { limit: 5 });

    expect(calls[0]?.url).toBe(
      "https://musubi.test/v1/episodic?namespace=eric%2Fopenclaw%2Fepisodic&limit=5",
    );
  });

  it("orders results newest-first by event_at", async () => {
    const { fetch } = createMockFetch([
      {
        status: 200,
        body: {
          items: [
            {
              object_id: "older",
              namespace: "eric/openclaw/episodic",
              content: "older capture",
              event_at: "2026-04-28T10:00:00Z",
            },
            {
              object_id: "newer",
              namespace: "eric/openclaw/episodic",
              content: "newer capture",
              event_at: "2026-04-29T18:00:00Z",
            },
          ],
        },
      },
    ]);
    const tool = createRecentTool({ client: makeClient(fetch), config: makeConfig() });

    const result = await tool.definition.execute("c", {});

    const text = result.content[0]!.text;
    // Newer should appear before older in the rendered output.
    const newerPos = text.indexOf("newer capture");
    const olderPos = text.indexOf("older capture");
    expect(newerPos).toBeGreaterThan(-1);
    expect(olderPos).toBeGreaterThan(-1);
    expect(newerPos).toBeLessThan(olderPos);
  });

  it("filters rows by tag — every listed tag must be present", async () => {
    const { fetch } = createMockFetch([
      {
        status: 200,
        body: {
          items: [
            {
              object_id: "a",
              content: "tagged",
              tags: ["src:openclaw-agent-remember", "important"],
              event_at: "2026-04-29T18:00:00Z",
            },
            {
              object_id: "b",
              content: "untagged",
              tags: ["passive"],
              event_at: "2026-04-29T17:00:00Z",
            },
          ],
        },
      },
    ]);
    const tool = createRecentTool({ client: makeClient(fetch), config: makeConfig() });

    const result = await tool.definition.execute("c", {
      tags: ["src:openclaw-agent-remember"],
    });

    const text = result.content[0]!.text;
    expect(text).toContain("tagged");
    expect(text).not.toContain("untagged");
  });

  it("applies the since filter — rows older than `since` are excluded", async () => {
    const { fetch } = createMockFetch([
      {
        status: 200,
        body: {
          items: [
            {
              object_id: "old",
              content: "before since",
              event_at: "2026-04-28T10:00:00Z",
            },
            {
              object_id: "new",
              content: "after since",
              event_at: "2026-04-29T18:00:00Z",
            },
          ],
        },
      },
    ]);
    const tool = createRecentTool({ client: makeClient(fetch), config: makeConfig() });

    const result = await tool.definition.execute("c", { since: "2026-04-29T00:00:00Z" });

    const text = result.content[0]!.text;
    expect(text).toContain("after since");
    expect(text).not.toContain("before since");
  });

  it("rejects invalid `since` value with a clear tool error", async () => {
    const { fetch } = createMockFetch([
      { status: 200, body: { items: [{ object_id: "a", content: "x" }] } },
    ]);
    const tool = createRecentTool({ client: makeClient(fetch), config: makeConfig() });

    const result = await tool.definition.execute("c", { since: "not-a-date" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Invalid 'since'");
  });

  it("returns a friendly empty-namespace message when no rows match", async () => {
    const { fetch } = createMockFetch([{ status: 200, body: { items: [] } }]);
    const tool = createRecentTool({ client: makeClient(fetch), config: makeConfig() });

    const result = await tool.definition.execute("c", {});

    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text).toContain("No recent activity");
    expect(result.content[0]?.text).toContain("eric/openclaw/episodic");
  });

  it("surfaces backend error as a tool error string", async () => {
    const { fetch } = createMockFetch([{ throw: new TypeError("fetch failed") }]);
    const tool = createRecentTool({ client: makeClient(fetch), config: makeConfig() });

    const result = await tool.definition.execute("c", {});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Musubi recent failed");
  });

  it("uses agent presence when agentId is provided", async () => {
    const { fetch, calls } = createMockFetch([{ status: 200, body: { items: [] } }]);
    const tool = createRecentTool({
      client: makeClient(fetch),
      config: makeConfig({
        presence: { defaultId: "eric/openclaw", perAgent: { aoi: "eric/aoi" } },
      }),
      agentId: "aoi",
    });

    await tool.definition.execute("c", {});
    expect(calls[0]?.url).toContain("namespace=eric%2Faoi%2Fepisodic");
  });
});
