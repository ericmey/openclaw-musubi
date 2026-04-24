import {
  DEFAULT_SUPPLEMENT_MAX_RESULTS,
  DEFAULT_SUPPLEMENT_PLANES,
  type MusubiConfig,
} from "../config.js";
import type { MusubiClient } from "../musubi/client.js";
import { resolvePresence } from "../presence/resolver.js";
import { buildRetrieveTargets } from "./retrieve-targets.js";

/**
 * `MemoryPromptSectionBuilder` matching the OpenClaw SDK shape — see
 * `src/plugins/memory-state.ts` in `openclaw@2026.4.19-beta.2`. Returns
 * an array of strings injected into the memory prompt.
 *
 * **Synchronous on purpose:** OpenClaw calls `build` per prompt assembly
 * with a tight latency budget. The supplement therefore reads from a
 * pre-warmed cache; HTTP I/O happens in `refresh()`, which the wiring
 * slice schedules out-of-band.
 */
export type PromptBuildParams = {
  readonly availableTools: ReadonlySet<string>;
  readonly citationsMode?: string;
};

export type PromptSupplement = {
  readonly enabled: boolean;
  build(params: PromptBuildParams): string[];
  refresh(options?: { readonly agentId?: string }): Promise<void>;
  /** Inspectable for tests; not part of the public API. */
  __cacheSize(): number;
};

export type CreatePromptSupplementOptions = {
  readonly client: MusubiClient;
  readonly config: MusubiConfig;
};

type StandingContextItem = {
  readonly plane: string;
  readonly content: string;
  readonly source: string;
  readonly title?: string;
};

type MusubiRetrieveRow = {
  readonly object_id: string;
  readonly score: number;
  readonly plane: string;
  readonly content: string;
  readonly namespace: string;
  readonly title?: string | null;
};

type MusubiRetrieveResponse = {
  readonly results: readonly MusubiRetrieveRow[];
};

const STANDING_CONTEXT_QUERY = "*";
const SECTION_HEADERS: Record<string, string> = {
  curated: "**Curated knowledge from Musubi (high provenance):**",
  concept: "**Synthesized concepts from Musubi (system hypotheses):**",
  episodic: "**Recent episodic memory from Musubi:**",
  artifact: "**Source artifacts from Musubi:**",
};

export function createPromptSupplement(options: CreatePromptSupplementOptions): PromptSupplement {
  const { client, config } = options;
  const supplementCfg = config.supplement ?? {};
  const enabled = supplementCfg.enabled !== false;
  const planes =
    supplementCfg.planes && supplementCfg.planes.length > 0
      ? [...supplementCfg.planes]
      : [...DEFAULT_SUPPLEMENT_PLANES];
  const cap = supplementCfg.maxResults ?? DEFAULT_SUPPLEMENT_MAX_RESULTS;

  let cache: readonly StandingContextItem[] = [];

  return {
    enabled,

    build(_params: PromptBuildParams): string[] {
      if (!enabled || cache.length === 0) return [];

      const lines: string[] = [];
      let firstSection = true;

      for (const plane of planes) {
        const items = cache.filter((item) => item.plane === plane);
        if (items.length === 0) continue;

        if (!firstSection) lines.push("");
        firstSection = false;

        const header = SECTION_HEADERS[plane] ?? `**Musubi ${plane}:**`;
        lines.push(header);
        for (const item of items) {
          const label = item.title ? `${item.title} — ${item.source}` : item.source;
          lines.push(`- ${item.content} (${label})`);
        }
      }

      return lines;
    },

    async refresh(refreshOptions = {}): Promise<void> {
      if (!enabled) return;

      let presence;
      try {
        presence = resolvePresence(config, { agentId: refreshOptions.agentId });
      } catch {
        cache = [];
        return;
      }

      // Collapse per-plane fanout into 2-segment cross-plane calls.
      const targets = buildRetrieveTargets(presence, planes);

      const settled = await Promise.allSettled(
        targets.map((t) =>
          client.post<MusubiRetrieveResponse>("/v1/retrieve", {
            body: {
              namespace: t.baseNamespace,
              planes: [...t.planes],
              query_text: STANDING_CONTEXT_QUERY,
              mode: "fast",
              limit: cap,
            },
            token: presence.token,
          }),
        ),
      );
      if (settled.every((r) => r.status === "rejected")) {
        // Complete failure — preserve stale cache instead of wiping.
        return;
      }
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
      merged.sort((a, b) => b.score - a.score);
      cache = merged.slice(0, cap).map(
        (row): StandingContextItem => ({
          plane: row.plane,
          content: row.content,
          source: row.namespace,
          title: row.title ?? undefined,
        }),
      );
    },

    __cacheSize() {
      return cache.length;
    },
  };
}
