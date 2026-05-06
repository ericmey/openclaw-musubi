import { MusubiError } from "../musubi/errors.js";
import { resolvePresence } from "../presence/resolver.js";
import { buildRetrieveTargets } from "../supplement/retrieve-targets.js";
import { SearchParameters } from "./parameters.js";
const DEFAULT_LIMIT = 10;
/**
 * Backing implementation. Exported so the deprecation alias in
 * `recall.ts` reuses the exact same code path — no parameter or
 * response drift between canonical and alias.
 */
export async function executeSearch(options, params) {
    const { client, config, agentId } = options;
    let presence;
    try {
        presence = resolvePresence(config, { agentId });
    }
    catch (err) {
        return toolError(`Presence unresolved: ${errorMessage(err)}`);
    }
    const limit = params.limit ?? DEFAULT_LIMIT;
    const defaultPlanes = ["curated", "concept", "episodic", "artifact"];
    const callerPlanes = params.planes ? [...params.planes] : defaultPlanes;
    const targets = buildRetrieveTargets(presence, callerPlanes);
    const settled = await Promise.allSettled(targets.map((t) => client.post("/v1/retrieve", {
        body: {
            namespace: t.baseNamespace,
            planes: [...t.planes],
            query_text: params.query,
            mode: "deep",
            limit,
        },
        token: presence.token,
    })));
    if (settled.every((r) => r.status === "rejected")) {
        const firstErr = settled[0].status === "rejected"
            ? settled[0].reason
            : new Error("unknown");
        return toolError(`Musubi search failed: ${errorMessage(firstErr)}`);
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
    const results = merged.slice(0, limit);
    if (results.length === 0) {
        return toolText(`No Musubi results for "${params.query}".`);
    }
    return toolText(formatResults(results));
}
export function createSearchTool(options) {
    return {
        recommendedOptional: true,
        definition: {
            name: "musubi_search",
            description: "Search Musubi across every plane (curated knowledge, synthesized concepts, episodic memory, source artifacts) using the full hybrid + rerank pipeline. Use when the passive memory supplement didn't surface what you need.",
            parameters: SearchParameters,
            async execute(_toolCallId, params) {
                return executeSearch(options, params);
            },
        },
    };
}
function formatResults(rows) {
    const lines = [];
    lines.push(`Musubi returned ${rows.length} result(s):`);
    lines.push("");
    for (const row of rows) {
        const label = row.title ? `${row.title}` : `${row.namespace}/${row.object_id}`;
        lines.push(`[${row.plane}] (score ${row.score.toFixed(2)}) ${label}`);
        lines.push(row.content);
        lines.push("");
    }
    return lines.join("\n").trimEnd();
}
function toolText(text) {
    return { content: [{ type: "text", text }] };
}
function toolError(text) {
    return { content: [{ type: "text", text }], isError: true };
}
function errorMessage(err) {
    if (err instanceof MusubiError)
        return `${err.name}: ${err.message}`;
    if (err instanceof Error)
        return err.message;
    return String(err);
}
//# sourceMappingURL=search.js.map