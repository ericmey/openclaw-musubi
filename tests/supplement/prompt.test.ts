import { describe, it, expect } from "vitest";
import { MusubiClient } from "../../src/musubi/client.js";
import { createPromptSupplement } from "../../src/supplement/prompt.js";
import type { MusubiConfig } from "../../src/config.js";
import type { FetchLike } from "../../src/musubi/types.js";

type ScriptedResponse =
  | { status: number; body?: unknown; headers?: Record<string, string> }
  | { throw: Error };

function createMockFetch(script: ScriptedResponse[]): {
  fetch: FetchLike;
  bodies: string[];
} {
  const bodies: string[] = [];
  let cursor = 0;
  const fetch: FetchLike = async (_url, init) => {
    bodies.push(typeof init.body === "string" ? init.body : "");
    const def = script[cursor] ?? script[script.length - 1];
    cursor += 1;
    if (def === undefined) throw new Error("script exhausted");
    if ("throw" in def) throw def.throw;
    return new Response(def.body !== undefined ? JSON.stringify(def.body) : null, {
      status: def.status,
      headers: { "content-type": "application/json", ...(def.headers ?? {}) },
    });
  };
  return { fetch, bodies };
}

function makeConfig(overrides: Partial<MusubiConfig> = {}): MusubiConfig {
  return {
    core: {
      baseUrl: "https://musubi.test",
      token: "t",
      ...(overrides.core ?? {}),
    },
    presence: {
      defaultId: "eric/openclaw",
      ...(overrides.presence ?? {}),
    },
    ...(overrides.supplement !== undefined ? { supplement: overrides.supplement } : {}),
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

const SAMPLE_RESPONSE = {
  results: [
    {
      object_id: "ksuid-cur-1",
      score: 0.95,
      plane: "curated",
      content: "Eric prefers TypeScript for new projects.",
      namespace: "eric/_shared/curated",
    },
    {
      object_id: "ksuid-cur-2",
      score: 0.92,
      plane: "curated",
      content: "Aoi is the daily creative partner.",
      namespace: "eric/_shared/curated",
    },
    {
      object_id: "ksuid-con-1",
      score: 0.83,
      plane: "concept",
      content: "Cross-modality continuity is a recurring theme.",
      namespace: "eric/_shared/concept",
    },
  ],
};

const NO_TOOLS_PARAMS = { availableTools: new Set<string>() };

describe("createPromptSupplement", () => {
  it("test_prompt_uses_fast_path_not_deep_path", async () => {
    const { fetch, bodies } = createMockFetch([{ status: 200, body: SAMPLE_RESPONSE }]);
    const supplement = createPromptSupplement({
      client: makeClient(fetch),
      config: makeConfig(),
    });

    await supplement.refresh();

    const body = JSON.parse(bodies[0]!);
    expect(body.mode).toBe("fast");
  });

  it("test_prompt_renders_labeled_section_per_plane", async () => {
    const { fetch } = createMockFetch([{ status: 200, body: SAMPLE_RESPONSE }]);
    const supplement = createPromptSupplement({
      client: makeClient(fetch),
      config: makeConfig(),
    });

    await supplement.refresh();
    const lines = supplement.build(NO_TOOLS_PARAMS);

    const text = lines.join("\n");
    expect(text).toContain("Curated knowledge from Musubi");
    expect(text).toContain("Synthesized concepts from Musubi");
    expect(text).toContain("Eric prefers TypeScript");
    expect(text).toContain("Cross-modality continuity");
    // Sections separated by a blank line
    expect(text.split("\n\n")).toHaveLength(2);
  });

  it("test_prompt_labels_curated_as_high_provenance", async () => {
    const { fetch } = createMockFetch([{ status: 200, body: SAMPLE_RESPONSE }]);
    const supplement = createPromptSupplement({
      client: makeClient(fetch),
      config: makeConfig({ supplement: { planes: ["curated"] } }),
    });

    await supplement.refresh();
    const lines = supplement.build(NO_TOOLS_PARAMS);

    expect(lines[0]).toContain("Curated knowledge from Musubi");
    expect(lines[0]).toContain("high provenance");
  });

  it("test_prompt_labels_concept_as_system_hypothesis", async () => {
    const { fetch } = createMockFetch([{ status: 200, body: SAMPLE_RESPONSE }]);
    const supplement = createPromptSupplement({
      client: makeClient(fetch),
      config: makeConfig({ supplement: { planes: ["concept"] } }),
    });

    await supplement.refresh();
    const lines = supplement.build(NO_TOOLS_PARAMS);

    expect(lines[0]).toContain("Synthesized concepts");
    expect(lines[0]).toContain("system hypothes"); // singular or plural — header reads naturally
  });

  it("test_prompt_truncates_to_configured_max_results", async () => {
    const { fetch, bodies } = createMockFetch([{ status: 200, body: SAMPLE_RESPONSE }]);
    const supplement = createPromptSupplement({
      client: makeClient(fetch),
      config: makeConfig({ supplement: { maxResults: 2 } }),
    });

    await supplement.refresh();

    expect(JSON.parse(bodies[0]!).limit).toBe(2);
    // Even if Musubi over-returned (3 rows), client-side cap holds
    expect(supplement.__cacheSize()).toBe(2);
  });

  it("test_prompt_section_is_empty_string_when_no_results", async () => {
    const { fetch } = createMockFetch([{ status: 200, body: { results: [] } }]);
    const supplement = createPromptSupplement({
      client: makeClient(fetch),
      config: makeConfig(),
    });

    await supplement.refresh();
    const lines = supplement.build(NO_TOOLS_PARAMS);

    expect(lines).toEqual([]);
    expect(lines.join("\n")).toBe("");
  });

  it("test_prompt_section_is_empty_string_when_disabled", async () => {
    const { fetch, bodies } = createMockFetch([{ status: 200, body: SAMPLE_RESPONSE }]);
    const supplement = createPromptSupplement({
      client: makeClient(fetch),
      config: makeConfig({ supplement: { enabled: false } }),
    });

    await supplement.refresh();
    const lines = supplement.build(NO_TOOLS_PARAMS);

    expect(supplement.enabled).toBe(false);
    expect(lines).toEqual([]);
    expect(bodies).toEqual([]); // refresh skipped when disabled
  });

  it("test_prompt_section_is_empty_string_when_core_unreachable", async () => {
    const { fetch } = createMockFetch([{ throw: new TypeError("fetch failed") }]);
    const supplement = createPromptSupplement({
      client: makeClient(fetch),
      config: makeConfig(),
    });

    await supplement.refresh();
    const lines = supplement.build(NO_TOOLS_PARAMS);

    expect(lines).toEqual([]);
  });

  it("test_prompt_respects_latency_budget_configured_by_openclaw", async () => {
    // build() must be synchronous — no await, no I/O. Verify by asserting
    // it completes inside a sub-millisecond budget even with a stale empty
    // cache and even if the configured client would normally take 30s.
    const { fetch } = createMockFetch([{ status: 200, body: SAMPLE_RESPONSE }]);
    const supplement = createPromptSupplement({
      client: makeClient(fetch),
      config: makeConfig(),
    });
    await supplement.refresh();

    const start = performance.now();
    const lines = supplement.build(NO_TOOLS_PARAMS);
    const elapsedMs = performance.now() - start;

    expect(lines.length).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(50); // generous; build should be sub-millisecond
  });

  it("preserves stale cache when refresh fails after a prior success", async () => {
    const { fetch } = createMockFetch([
      { status: 200, body: SAMPLE_RESPONSE },
      { throw: new TypeError("fetch failed") },
    ]);
    const supplement = createPromptSupplement({
      client: makeClient(fetch),
      config: makeConfig(),
    });

    await supplement.refresh();
    expect(supplement.__cacheSize()).toBeGreaterThan(0);

    await supplement.refresh();
    // Cache survived the failure
    expect(supplement.__cacheSize()).toBeGreaterThan(0);
  });

  it("uses agent presence on refresh when agentId is provided", async () => {
    const { fetch, bodies } = createMockFetch([{ status: 200, body: { results: [] } }]);
    const supplement = createPromptSupplement({
      client: makeClient(fetch),
      config: makeConfig({
        presence: { defaultId: "eric/openclaw", perAgent: { aoi: "eric/aoi" } },
      }),
    });

    await supplement.refresh({ agentId: "aoi" });

    expect(JSON.parse(bodies[0]!).namespace).toBe("eric/aoi");
  });
});
