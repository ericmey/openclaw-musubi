import {
  DEFAULT_SUPPLEMENT_MAX_RESULTS,
  DEFAULT_SUPPLEMENT_PLANES,
  type MusubiConfig,
} from "../config.js";
import type { MusubiClient } from "../musubi/client.js";
import { resolvePresence } from "../presence/resolver.js";
import { buildRetrieveTargets } from "./retrieve-targets.js";

/**
 * Structural shape of a single result row consumed by OpenClaw's
 * `MemoryCorpusSupplement.search` callback. Mirrors `MemoryCorpusSearchResult`
 * in the OpenClaw SDK (`src/plugins/memory-state.ts`) — duplicated here so
 * this slice does not depend on a specific SDK version's type re-exports.
 * The integration slice that wires this into a `definePluginEntry` callback
 * will assert structural compatibility.
 */
export type CorpusSearchResult = {
  readonly corpus: string;
  readonly path: string;
  readonly score: number;
  readonly snippet: string;
  readonly title?: string;
  readonly kind?: string;
  readonly id?: string;
  readonly source?: string;
  readonly provenanceLabel?: string;
};

export type CorpusGetResult = {
  readonly corpus: string;
  readonly path: string;
  readonly title?: string;
  readonly kind?: string;
  readonly content: string;
  readonly fromLine: number;
  readonly lineCount: number;
};

export type CorpusSupplement = {
  readonly enabled: boolean;
  search(params: {
    query: string;
    maxResults?: number;
    agentSessionKey?: string;
  }): Promise<CorpusSearchResult[]>;
  get(params: {
    lookup: string;
    fromLine?: number;
    lineCount?: number;
    agentSessionKey?: string;
  }): Promise<CorpusGetResult | null>;
};

export type CreateCorpusSupplementOptions = {
  readonly client: MusubiClient;
  readonly config: MusubiConfig;
};

export const CORPUS_NAME = "musubi";

type MusubiRetrieveRow = {
  readonly object_id: string;
  readonly score: number;
  readonly plane: string;
  readonly content: string;
  readonly namespace: string;
  readonly title?: string | null;
  readonly extra?: Record<string, unknown>;
};

type MusubiRetrieveResponse = {
  readonly results: readonly MusubiRetrieveRow[];
  readonly mode: string;
  readonly limit: number;
};

type MusubiObjectFetchResponse = {
  readonly object_id?: string;
  readonly content?: string;
  readonly title?: string;
  readonly namespace?: string;
};

const SNIPPET_MAX_CHARS = 280;

/**
 * Build a `MemoryCorpusSupplement`-shaped object that reads from Musubi's
 * `/v1/retrieve` (search) and `/v1/curated/{id}` / `/v1/concepts/{id}` (get).
 *
 * The supplement is **non-blocking** for OpenClaw's memory search: any error
 * reaching Musubi (network, auth, server) returns an empty result set rather
 * than failing the search, so users always get *something* even if Musubi
 * is temporarily unreachable.
 */
export function createCorpusSupplement(options: CreateCorpusSupplementOptions): CorpusSupplement {
  const { client, config } = options;
  const supplementCfg = config.supplement ?? {};
  const enabled = supplementCfg.enabled !== false;
  const planes =
    supplementCfg.planes && supplementCfg.planes.length > 0
      ? [...supplementCfg.planes]
      : [...DEFAULT_SUPPLEMENT_PLANES];
  const cap = supplementCfg.maxResults ?? DEFAULT_SUPPLEMENT_MAX_RESULTS;

  return {
    enabled,

    async search(params) {
      if (!enabled) return [];

      let presence;
      try {
        presence = resolvePresence(config, { agentId: params.agentSessionKey });
      } catch {
        return [];
      }

      const limit = Math.max(1, Math.min(params.maxResults ?? cap, cap));

      // Collapse per-plane fanout into 2-segment cross-plane calls.
      // One call per unique base namespace, with all readable planes
      // in the `planes` array. The server expands and merges internally.
      const targets = buildRetrieveTargets(presence, planes);

      const settled = await Promise.allSettled(
        targets.map((t) =>
          client.post<MusubiRetrieveResponse>("/v1/retrieve", {
            body: {
              namespace: t.baseNamespace,
              planes: [...t.planes],
              query_text: params.query,
              mode: "fast",
              limit,
            },
            token: presence.token,
          }),
        ),
      );
      const seen = new Set<string>();
      const merged: MusubiRetrieveRow[] = [];
      for (const result of settled) {
        if (result.status !== "fulfilled") continue;
        for (const row of result.value.results ?? []) {
          if (seen.has(row.object_id)) continue;
          seen.add(row.object_id);
          merged.push(row);
        }
      }
      if (merged.length === 0 && settled.every((r) => r.status === "rejected")) {
        return [];
      }
      merged.sort((a, b) => b.score - a.score);
      return merged.slice(0, limit).map(toCorpusSearchResult);
    },

    async get(params) {
      if (!enabled) return null;

      const [plane, id] = splitLookup(params.lookup);
      if (plane === undefined || id === undefined) return null;

      let presence;
      try {
        presence = resolvePresence(config, { agentId: params.agentSessionKey });
      } catch {
        return null;
      }

      const path = endpointForPlane(plane, id);
      if (path === undefined) return null;

      // Derive the correct namespace for the ?namespace= query param.
      const ns =
        plane === "episodic"
          ? presence.namespaces.episodic
          : plane === "thought"
            ? presence.namespaces.thought
            : plane === "artifact"
              ? presence.namespaces.artifact
              : (presence.namespaces.curatedReadScope.find((n) => n.endsWith(`/${plane}`)) ??
                presence.namespaces.episodic);

      try {
        const obj = await client.getWithQuery<MusubiObjectFetchResponse>(
          path,
          { namespace: ns },
          { token: presence.token },
        );
        return toCorpusGetResult(obj, plane, params.lookup);
      } catch {
        return null;
      }
    },
  };
}

function splitLookup(lookup: string): [string?, string?] {
  const idx = lookup.indexOf("/");
  if (idx <= 0 || idx === lookup.length - 1) return [];
  return [lookup.slice(0, idx), lookup.slice(idx + 1)];
}

function endpointForPlane(plane: string, id: string): string | undefined {
  const safeId = encodeURIComponent(id);
  if (plane === "curated") return `/v1/curated/${safeId}`;
  if (plane === "concept") return `/v1/concepts/${safeId}`;
  if (plane === "episodic") return `/v1/episodic/${safeId}`;
  if (plane === "artifact") return `/v1/artifacts/${safeId}`;
  return undefined;
}

function toCorpusSearchResult(row: MusubiRetrieveRow): CorpusSearchResult {
  return {
    corpus: CORPUS_NAME,
    path: `${row.plane}/${row.object_id}`,
    score: row.score,
    snippet: row.content.slice(0, SNIPPET_MAX_CHARS),
    title: row.title ?? undefined,
    id: row.object_id,
    source: row.namespace,
    provenanceLabel: provenanceLabelFor(row.plane),
    kind: row.plane,
  };
}

function provenanceLabelFor(plane: string): string {
  if (plane === "curated") return "Curated knowledge (high provenance)";
  if (plane === "concept") return "Synthesized concept (system hypothesis)";
  if (plane === "episodic") return "Recent episodic memory";
  if (plane === "artifact") return "Source artifact";
  return plane;
}

function toCorpusGetResult(
  obj: MusubiObjectFetchResponse,
  plane: string,
  lookup: string,
): CorpusGetResult {
  const content = obj.content ?? "";
  return {
    corpus: CORPUS_NAME,
    path: lookup,
    title: obj.title,
    kind: plane,
    content,
    fromLine: 0,
    lineCount: content.split("\n").length,
  };
}
