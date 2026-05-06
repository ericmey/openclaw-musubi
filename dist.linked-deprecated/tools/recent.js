import { MusubiError } from "../musubi/errors.js";
import { resolvePresence } from "../presence/resolver.js";
import { RecentParameters } from "./parameters.js";
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;
export function createRecentTool(options) {
    const { client, config, agentId } = options;
    return {
        recommendedOptional: true,
        definition: {
            name: "musubi_recent",
            description: "Recent activity from the calling presence's episodic memory, newest-first. No query needed — ask 'what was I just doing?' and the agent gets the last N captures. Cross-modal scope is forthcoming; today, presence-only.",
            parameters: RecentParameters,
            async execute(_toolCallId, params) {
                let presence;
                try {
                    presence = resolvePresence(config, { agentId });
                }
                catch (err) {
                    return toolError(`Presence unresolved: ${errorMessage(err)}`);
                }
                const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
                const namespace = presence.namespaces.episodic;
                let page;
                try {
                    page = await client.getWithQuery("/v1/episodic", { namespace, limit }, { token: presence.token });
                }
                catch (err) {
                    return toolError(`Musubi recent failed: ${errorMessage(err)}`);
                }
                let rows = page.items ?? [];
                // Apply tag filter — every listed tag must be in row.tags.
                if (params.tags && params.tags.length > 0) {
                    const required = params.tags;
                    rows = rows.filter((r) => required.every((t) => (r.tags ?? []).includes(t)));
                }
                // Apply since filter — row's primary timestamp >= since.
                if (params.since) {
                    const sinceMs = Date.parse(params.since);
                    if (!Number.isFinite(sinceMs)) {
                        return toolError(`Invalid 'since' value '${params.since}': expected ISO-8601 timestamp.`);
                    }
                    rows = rows.filter((r) => {
                        const tsMs = pickTimestampMs(r);
                        return tsMs !== undefined && tsMs >= sinceMs;
                    });
                }
                // Sort newest-first by event_at (preferred), then created_at,
                // then created_epoch as last-resort fallback. The API page is
                // Qdrant-scroll-ordered (undefined), so client-side sort is
                // load-bearing for "recent" semantics.
                const sorted = [...rows].sort((a, b) => {
                    const ta = pickTimestampMs(a) ?? 0;
                    const tb = pickTimestampMs(b) ?? 0;
                    return tb - ta;
                });
                const top = sorted.slice(0, limit);
                if (top.length === 0) {
                    return toolText(`No recent activity in ${namespace}.`);
                }
                return toolText(formatResults(namespace, top));
            },
        },
    };
}
function pickTimestampMs(row) {
    if (row.event_at) {
        const ms = Date.parse(row.event_at);
        if (Number.isFinite(ms))
            return ms;
    }
    if (row.created_at) {
        const ms = Date.parse(row.created_at);
        if (Number.isFinite(ms))
            return ms;
    }
    if (row.ingested_at) {
        const ms = Date.parse(row.ingested_at);
        if (Number.isFinite(ms))
            return ms;
    }
    if (typeof row.created_epoch === "number") {
        return row.created_epoch * 1000;
    }
    return undefined;
}
function formatResults(namespace, rows) {
    const lines = [];
    lines.push(`Recent activity (${namespace}, last ${rows.length}):`);
    lines.push("");
    for (const row of rows) {
        const ts = row.event_at ?? row.created_at ?? row.ingested_at ?? "(no timestamp)";
        const oid = row.object_id ?? "<no-id>";
        const content = (row.content ?? "").trim();
        lines.push(`[${ts}] ${namespace}/${oid}`);
        if (content)
            lines.push(content);
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
//# sourceMappingURL=recent.js.map