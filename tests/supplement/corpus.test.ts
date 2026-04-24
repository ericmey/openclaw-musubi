import { describe, it, expect } from "vitest";
import { MusubiClient } from "../../src/musubi/client.js";
import { createCorpusSupplement, type CorpusSearchResult } from "../../src/supplement/corpus.js";
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
    const headerInit = init.headers;
    if (headerInit) {
      if (headerInit instanceof Headers) {
        headerInit.forEach((value, key) => {
          headers[key] = value;
        });
      } else if (Array.isArray(headerInit)) {
        for (const [k, v] of headerInit) headers[k] = v;
      } else {
        for (const [k, v] of Object.entries(headerInit as Record<string, string>)) {
          headers[k] = v;
        }
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
    if (def === undefined) throw new Error("mock fetch script exhausted");
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
    core: {
      baseUrl: "https://musubi.test",
      token: "test-token",
      ...(overrides.core ?? {}),
    },
    presence: {
      defaultId: "eric/openclaw",
      ...(overrides.presence ?? {}),
    },
    ...(overrides.supplement !== undefined ? { supplement: overrides.supplement } : {}),
    ...(overrides.capture !== undefined ? { capture: overrides.capture } : {}),
    ...(overrides.thoughts !== undefined ? { thoughts: overrides.thoughts } : {}),
  };
}

function makeClient(fetch: FetchLike) {
  return new MusubiClient({
    baseUrl: "https://musubi.test",
    token: "test-token",
    fetch,
    sleep: async () => undefined,
    random: () => 0,
    generateRequestId: () => "req-id",
    generateIdempotencyKey: () => "idem-key",
    retry: { maxAttempts: 1 },
  });
}

const SAMPLE_RETRIEVE_RESPONSE = {
  results: [
    {
      object_id: "ksuid-cur-1",
      score: 0.95,
      plane: "curated",
      content: "Eric prefers TypeScript over JavaScript for new projects.",
      namespace: "eric/_shared/curated",
    },
    {
      object_id: "ksuid-con-1",
      score: 0.83,
      plane: "concept",
      content: "Cross-modality memory continuity emerges as a recurring theme.",
      namespace: "eric/_shared/concept",
    },
  ],
  mode: "fast",
  limit: 5,
};

describe("createCorpusSupplement", () => {
  it("test_supplement_queries_retrieve_with_fast_mode", async () => {
    const { fetch, calls } = createMockFetch([{ status: 200, body: SAMPLE_RETRIEVE_RESPONSE }]);
    const supplement = createCorpusSupplement({
      client: makeClient(fetch),
      config: makeConfig(),
    });

    await supplement.search({ query: "what does eric prefer?" });

    // Canonical retrieve is one-call-per-plane; default planes are
    // curated + concept → two calls. Each carries `mode: "fast"` and
    // the same `query_text`.
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.url).toBe("https://musubi.test/v1/retrieve");
      expect(call.method).toBe("POST");
      const body = JSON.parse(call.body!);
      expect(body.mode).toBe("fast");
      expect(body.query_text).toBe("what does eric prefer?");
    }
  });

  it("test_supplement_filters_to_configured_planes", async () => {
    const { fetch, calls } = createMockFetch([
      { status: 200, body: { results: [], mode: "fast", limit: 5 } },
    ]);
    const client = makeClient(fetch);

    const defaultSupplement = createCorpusSupplement({ client, config: makeConfig() });
    await defaultSupplement.search({ query: "x" });
    const defaultPlanes = calls.map((c) => JSON.parse(c.body!).planes[0]);
    const defaultBefore = calls.length;
    // Default planes are curated + concept; one retrieve call per plane.
    expect(new Set(defaultPlanes)).toEqual(new Set(["curated", "concept"]));

    const customSupplement = createCorpusSupplement({
      client,
      config: makeConfig({ supplement: { planes: ["curated"] } }),
    });
    await customSupplement.search({ query: "x" });
    const customCalls = calls.slice(defaultBefore);
    const customPlanes = customCalls.map((c) => JSON.parse(c.body!).planes[0]);
    // `planes: ["curated"]` fans across every readable curated
    // namespace — own + shared per the presence resolver — so we
    // see multiple calls, all for the curated plane.
    expect(customPlanes.length).toBeGreaterThan(0);
    for (const plane of customPlanes) {
      expect(plane).toBe("curated");
    }
  });

  it("test_supplement_respects_max_results_cap", async () => {
    const { fetch, calls } = createMockFetch([
      { status: 200, body: { results: [], mode: "fast", limit: 3 } },
    ]);
    const supplement = createCorpusSupplement({
      client: makeClient(fetch),
      config: makeConfig({ supplement: { maxResults: 3 } }),
    });

    // Caller passes a higher limit; cap wins. Each per-plane call
    // carries the same capped limit.
    await supplement.search({ query: "x", maxResults: 50 });
    const firstWave = calls.splice(0, calls.length);
    expect(firstWave.length).toBeGreaterThan(0);
    for (const call of firstWave) {
      expect(JSON.parse(call.body!).limit).toBe(3);
    }

    // Caller passes lower; their value wins.
    await supplement.search({ query: "x", maxResults: 1 });
    for (const call of calls) {
      expect(JSON.parse(call.body!).limit).toBe(1);
    }
  });

  it("test_supplement_returns_rows_with_plane_score_namespace_and_content", async () => {
    const { fetch } = createMockFetch([{ status: 200, body: SAMPLE_RETRIEVE_RESPONSE }]);
    const supplement = createCorpusSupplement({
      client: makeClient(fetch),
      config: makeConfig(),
    });

    const results = await supplement.search({ query: "x" });

    expect(results).toHaveLength(2);
    const cur = results[0] as CorpusSearchResult;
    expect(cur.corpus).toBe("musubi");
    expect(cur.score).toBe(0.95);
    expect(cur.kind).toBe("curated");
    expect(cur.source).toBe("eric/_shared/curated");
    expect(cur.id).toBe("ksuid-cur-1");
    expect(cur.path).toBe("curated/ksuid-cur-1");
    expect(cur.snippet).toContain("TypeScript");
    expect(cur.provenanceLabel).toContain("Curated");

    const concept = results[1] as CorpusSearchResult;
    expect(concept.kind).toBe("concept");
    expect(concept.provenanceLabel).toContain("hypothesis");
  });

  it("test_supplement_returns_empty_when_core_unreachable", async () => {
    const { fetch } = createMockFetch([{ throw: new TypeError("fetch failed") }]);
    const supplement = createCorpusSupplement({
      client: makeClient(fetch),
      config: makeConfig(),
    });

    const results = await supplement.search({ query: "x" });

    expect(results).toEqual([]);
  });

  it("test_supplement_returns_empty_when_disabled_in_config", async () => {
    const { fetch, calls } = createMockFetch([{ status: 200, body: SAMPLE_RETRIEVE_RESPONSE }]);
    const supplement = createCorpusSupplement({
      client: makeClient(fetch),
      config: makeConfig({ supplement: { enabled: false } }),
    });

    const results = await supplement.search({ query: "x" });

    expect(results).toEqual([]);
    expect(calls).toEqual([]); // never even hit the network
    expect(supplement.enabled).toBe(false);
  });

  it("test_supplement_uses_agent_presence_when_agent_id_is_provided", async () => {
    const { fetch, calls } = createMockFetch([
      { status: 200, body: { results: [], mode: "fast", limit: 5 } },
    ]);
    const supplement = createCorpusSupplement({
      client: makeClient(fetch),
      config: makeConfig({
        presence: {
          defaultId: "eric/openclaw",
          perAgent: { aoi: "eric/aoi" },
        },
      }),
    });

    await supplement.search({ query: "x", agentSessionKey: "aoi" });

    // Every per-plane call is scoped to a 3-segment namespace. For
    // agent "aoi" the targets are `eric/aoi/curated` and the shared
    // curated/concept pools under `eric/_shared/*`.
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const ns: string = JSON.parse(call.body!).namespace;
      expect(ns.startsWith("eric/aoi/") || ns.startsWith("eric/_shared/")).toBe(true);
    }
  });

  it("test_supplement_uses_default_presence_when_no_agent_id", async () => {
    const { fetch, calls } = createMockFetch([
      { status: 200, body: { results: [], mode: "fast", limit: 5 } },
    ]);
    const supplement = createCorpusSupplement({
      client: makeClient(fetch),
      config: makeConfig({
        presence: {
          defaultId: "eric/openclaw",
          perAgent: { aoi: "eric/aoi" },
        },
      }),
    });

    await supplement.search({ query: "x" });

    // Default presence "eric/openclaw"; every per-plane call is
    // scoped under `eric/openclaw/<plane>` or the shared pool.
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      const ns: string = JSON.parse(call.body!).namespace;
      expect(ns.startsWith("eric/openclaw/") || ns.startsWith("eric/_shared/")).toBe(
        true,
      );
    }
  });

  it("get fetches a curated object by lookup path", async () => {
    const { fetch, calls } = createMockFetch([
      { status: 200, body: { object_id: "abc", content: "line one\nline two", title: "Note" } },
    ]);
    const supplement = createCorpusSupplement({
      client: makeClient(fetch),
      config: makeConfig(),
    });

    const result = await supplement.get({ lookup: "curated/abc" });

    expect(calls[0]?.url).toBe(
      "https://musubi.test/v1/curated/abc?namespace=eric%2Fopenclaw%2Fcurated",
    );
    expect(result?.title).toBe("Note");
    expect(result?.content).toBe("line one\nline two");
    expect(result?.lineCount).toBe(2);
    expect(result?.kind).toBe("curated");
  });

  it("get returns null on fetch failure", async () => {
    const { fetch } = createMockFetch([{ status: 404 }]);
    const supplement = createCorpusSupplement({
      client: makeClient(fetch),
      config: makeConfig(),
    });

    const result = await supplement.get({ lookup: "curated/missing" });

    expect(result).toBeNull();
  });

  it("get returns null for malformed lookup", async () => {
    const { fetch, calls } = createMockFetch([{ status: 200, body: {} }]);
    const supplement = createCorpusSupplement({
      client: makeClient(fetch),
      config: makeConfig(),
    });

    expect(await supplement.get({ lookup: "no-slash" })).toBeNull();
    expect(await supplement.get({ lookup: "/leading-slash" })).toBeNull();
    expect(await supplement.get({ lookup: "trailing/" })).toBeNull();
    expect(await supplement.get({ lookup: "unknown-plane/abc" })).toBeNull();
    expect(calls).toEqual([]);
  });
});
