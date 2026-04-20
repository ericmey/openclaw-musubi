import {
  DEFAULT_SUPPLEMENT_MAX_RESULTS,
  DEFAULT_SUPPLEMENT_PLANES,
  type MusubiConfig,
} from "../config.js";
import type { MusubiClient } from "../musubi/client.js";
import { resolvePresence } from "../presence/resolver.js";

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
};

type MusubiRetrieveRow = {
  readonly object_id: string;
  readonly score: number;
  readonly plane: string;
  readonly content: string;
  readonly namespace: string;
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
          lines.push(`- ${item.content} (${item.source})`);
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

      try {
        const response = await client.post<MusubiRetrieveResponse>("/v1/retrieve", {
          body: {
            query_text: STANDING_CONTEXT_QUERY,
            mode: "fast",
            planes,
            limit: cap,
            namespace: presence.presence,
          },
        });
        const next = (response.results ?? []).slice(0, cap).map(
          (row): StandingContextItem => ({
            plane: row.plane,
            content: row.content,
            source: row.namespace,
          }),
        );
        cache = next;
      } catch {
        // Preserve stale cache on transient failure; better than going empty.
      }
    },

    __cacheSize() {
      return cache.length;
    },
  };
}
