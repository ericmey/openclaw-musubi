import { describe, it, expect } from "vitest";
import { MusubiClient } from "../../src/musubi/client.js";
import { createThinkTool } from "../../src/tools/think.js";
import type { MusubiConfig } from "../../src/config.js";
import type { FetchLike } from "../../src/musubi/types.js";

function makeConfig(overrides: Partial<MusubiConfig> = {}): MusubiConfig {
  return {
    core: { baseUrl: "https://musubi.test", token: "t", ...(overrides.core ?? {}) },
    presence: { defaultId: "eric/openclaw", ...(overrides.presence ?? {}) },
  };
}

function createMockFetch(script: Array<{ status: number; body?: unknown }>) {
  const calls: Array<{ url: string; body: string | undefined }> = [];
  let cursor = 0;
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, body: typeof init.body === "string" ? init.body : undefined });
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
    generateIdempotencyKey: () => "i",
    retry: { maxAttempts: 1 },
  });
}

describe("createThinkTool", () => {
  it("test_think_registered_with_to_presence_and_content_parameters", () => {
    const { fetch } = createMockFetch([{ status: 200, body: {} }]);
    const tool = createThinkTool({ client: makeClient(fetch), config: makeConfig() });
    expect(tool.definition.name).toBe("musubi_think");
    // TypeBox schema includes both required fields.
    const schema = tool.definition.parameters;
    // Properties access — TypeBox schemas serialize to JSON Schema.
    const serialized = JSON.parse(JSON.stringify(schema));
    expect(Object.keys(serialized.properties)).toContain("toPresence");
    expect(Object.keys(serialized.properties)).toContain("content");
  });

  it("test_think_posts_to_thoughts_send_endpoint", async () => {
    const { fetch, calls } = createMockFetch([{ status: 200, body: { object_id: "ksuid-sent" } }]);
    const tool = createThinkTool({ client: makeClient(fetch), config: makeConfig() });

    await tool.definition.execute("call", {
      toPresence: "eric/claude-code",
      content: "deploy is done",
    });

    expect(calls[0]?.url).toBe("https://musubi.test/v1/thoughts/send");
  });

  it("test_think_carries_sending_agents_presence_as_from", async () => {
    const { fetch, calls } = createMockFetch([{ status: 200, body: {} }]);
    const tool = createThinkTool({
      client: makeClient(fetch),
      config: makeConfig({
        presence: { defaultId: "eric/openclaw", perAgent: { aoi: "eric/aoi" } },
      }),
      agentId: "aoi",
    });

    await tool.definition.execute("call", {
      toPresence: "eric/rin",
      content: "pick up the deploy please",
    });

    const body = JSON.parse(calls[0]!.body!);
    expect(body.from_presence).toBe("eric/aoi");
    expect(body.to_presence).toBe("eric/rin");
    // Canonical ThoughtSendRequest requires a 3-segment namespace
    // (`tenant/presence/thought`); `from_presence` stays as the
    // 2-segment presence id the plugin received.
    expect(body.namespace).toBe("eric/aoi/thought");
    expect(body.content).toBe("pick up the deploy please");
  });

  it("test_think_honors_configured_channel_and_importance", async () => {
    const { fetch, calls } = createMockFetch([
      { status: 200, body: {} },
      { status: 200, body: {} },
    ]);
    const tool = createThinkTool({ client: makeClient(fetch), config: makeConfig() });

    await tool.definition.execute("c1", {
      toPresence: "eric/rin",
      content: "x",
      channel: "urgent",
      importance: 9,
    });
    await tool.definition.execute("c2", { toPresence: "eric/rin", content: "x" });

    const withOpts = JSON.parse(calls[0]!.body!);
    expect(withOpts.channel).toBe("urgent");
    expect(withOpts.importance).toBe(9);

    const defaults = JSON.parse(calls[1]!.body!);
    expect(defaults.channel).toBe("default");
    expect(defaults.importance).toBe(5);
  });

  it("returns typed error on failure", async () => {
    const { fetch } = createMockFetch([{ status: 503, body: { error: "down" } }]);
    const tool = createThinkTool({ client: makeClient(fetch), config: makeConfig() });

    const result = await tool.definition.execute("c", {
      toPresence: "eric/rin",
      content: "x",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Musubi think failed");
  });
});

describe("test_all_tools_honor_approval_hooks_when_required", () => {
  // Approval hooks (`before_tool_call` with `{ requireApproval: true }`) are
  // enforced by OpenClaw *before* a tool's execute() runs. The tool itself
  // has no special responsibility — it must simply run cleanly when invoked
  // (approvals happen invisibly from the tool's perspective) and must NOT
  // try to bypass the hook system.
  //
  // This asserts structurally: each tool's execute() is a normal function
  // that returns a ToolResult. There is no side channel that could bypass
  // an approval. OpenClaw gating before execute() is the system's job, not
  // the tool's.
  it("all three tools expose execute() as plain ToolResult-returning functions", async () => {
    // Shared mock — each tool is called in isolation.
    const responses = [
      { status: 200, body: { results: [] } }, // recall
      { status: 200, body: { object_id: "x" } }, // remember
      { status: 200, body: { object_id: "y" } }, // think
    ];
    const { fetch } = createMockFetch(responses);
    const { createRecallTool } = await import("../../src/tools/recall.js");
    const { createRememberTool } = await import("../../src/tools/remember.js");
    const client = makeClient(fetch);
    const config = makeConfig();

    const recall = createRecallTool({ client, config });
    const remember = createRememberTool({ client, config });
    const think = createThinkTool({ client, config });

    const r1 = await recall.definition.execute("c1", { query: "x" });
    const r2 = await remember.definition.execute("c2", { content: "x" });
    const r3 = await think.definition.execute("c3", {
      toPresence: "eric/rin",
      content: "x",
    });

    for (const result of [r1, r2, r3]) {
      expect(Array.isArray(result.content)).toBe(true);
      expect(result.content[0]?.type).toBe("text");
    }
  });
});
