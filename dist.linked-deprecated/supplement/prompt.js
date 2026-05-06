import { DEFAULT_SUPPLEMENT_MAX_RESULTS, DEFAULT_SUPPLEMENT_PLANES, } from "../config.js";
import { resolvePresence } from "../presence/resolver.js";
import { buildRetrieveTargets } from "./retrieve-targets.js";
const STANDING_CONTEXT_QUERY = "*";
const SECTION_HEADERS = {
    curated: "**Curated knowledge from Musubi (high provenance):**",
    concept: "**Synthesized concepts from Musubi (system hypotheses):**",
    episodic: "**Recent episodic memory from Musubi:**",
    artifact: "**Source artifacts from Musubi:**",
};
export function createPromptSupplement(options) {
    const { client, config } = options;
    const supplementCfg = config.supplement ?? {};
    const enabled = supplementCfg.enabled !== false;
    const planes = supplementCfg.planes && supplementCfg.planes.length > 0
        ? [...supplementCfg.planes]
        : [...DEFAULT_SUPPLEMENT_PLANES];
    const cap = supplementCfg.maxResults ?? DEFAULT_SUPPLEMENT_MAX_RESULTS;
    let cache = [];
    return {
        enabled,
        build(_params) {
            if (!enabled || cache.length === 0)
                return [];
            const lines = [];
            let firstSection = true;
            for (const plane of planes) {
                const items = cache.filter((item) => item.plane === plane);
                if (items.length === 0)
                    continue;
                if (!firstSection)
                    lines.push("");
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
        async refresh(refreshOptions = {}) {
            if (!enabled)
                return;
            let presence;
            try {
                presence = resolvePresence(config, { agentId: refreshOptions.agentId });
            }
            catch {
                cache = [];
                return;
            }
            // Collapse per-plane fanout into 2-segment cross-plane calls.
            const targets = buildRetrieveTargets(presence, planes);
            const settled = await Promise.allSettled(targets.map((t) => client.post("/v1/retrieve", {
                body: {
                    namespace: t.baseNamespace,
                    planes: [...t.planes],
                    query_text: STANDING_CONTEXT_QUERY,
                    mode: "fast",
                    limit: cap,
                },
                token: presence.token,
            })));
            if (settled.every((r) => r.status === "rejected")) {
                // Complete failure — preserve stale cache instead of wiping.
                return;
            }
            const seen = new Set();
            const merged = [];
            for (const result of settled) {
                if (result.status !== "fulfilled")
                    continue;
                for (const row of result.value.results ?? []) {
                    if (seen.has(row.object_id))
                        continue;
                    seen.add(row.object_id);
                    merged.push(row);
                }
            }
            merged.sort((a, b) => b.score - a.score);
            cache = merged.slice(0, cap).map((row) => ({
                plane: row.plane,
                content: row.content,
                source: row.namespace,
                title: row.title ?? undefined,
            }));
        },
        __cacheSize() {
            return cache.length;
        },
    };
}
//# sourceMappingURL=prompt.js.map