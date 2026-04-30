import type { MusubiConfig } from "../config.js";
import type { MusubiClient } from "../musubi/client.js";
import { MusubiError } from "../musubi/errors.js";
import { resolvePresence } from "../presence/resolver.js";
import { RecentParameters, type RecentParams } from "./parameters.js";

/**
 * Agent-callable recency-anchored episodic recall — `musubi_recent`.
 *
 * The agent asks "what's recent?" without supplying a query. Returns
 * the most recently captured episodic rows from the calling presence's
 * stream, ordered newest-first.
 *
 * **Scope today is presence-only** (`<tenant>/<presence>/episodic`).
 * Cross-modal scope (`<tenant>/*\/episodic`) lights up when:
 *   1. `slice-api-retrieve-wildcards` (Musubi #266) ships — wildcard
 *      namespace primitive on retrieve.
 *   2. `slice-retrieve-recent` (Musubi #288) ships — `mode=recent`
 *      bypassing the query-required pipeline.
 *
 * Until both land, this fallback paginates `GET /v1/episodic` for the
 * presence's own namespace and sorts client-side by event timestamp.
 * The fallback is documented in [[07-interfaces/agent-tools]] and
 * [[_slices/slice-openclaw-canonical-tools]] § Depends on.
 */

export type ToolDefinition = {
  readonly name: string;
  readonly description: string;
  readonly parameters: typeof RecentParameters;
  execute(toolCallId: string, params: RecentParams): Promise<ToolResult>;
};

export type ToolResult = {
  readonly content: ReadonlyArray<{ type: "text"; text: string }>;
  readonly isError?: boolean;
};

export type CreateRecentToolOptions = {
  readonly client: MusubiClient;
  readonly config: MusubiConfig;
  readonly agentId?: string;
};

export type RecentTool = {
  readonly definition: ToolDefinition;
  readonly recommendedOptional: true;
};

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

type EpisodicRow = {
  readonly object_id?: string;
  readonly namespace?: string;
  readonly content?: string;
  readonly tags?: readonly string[];
  readonly event_at?: string;
  readonly ingested_at?: string;
  readonly created_at?: string;
  readonly created_epoch?: number;
};

type EpisodicPage = {
  readonly items: readonly EpisodicRow[];
  readonly next_cursor?: string | null;
};

export function createRecentTool(options: CreateRecentToolOptions): RecentTool {
  const { client, config, agentId } = options;

  return {
    recommendedOptional: true,
    definition: {
      name: "musubi_recent",
      description:
        "Recent activity from the calling presence's episodic memory, newest-first. No query needed — ask 'what was I just doing?' and the agent gets the last N captures. Cross-modal scope is forthcoming; today, presence-only.",
      parameters: RecentParameters,
      async execute(_toolCallId, params) {
        let presence;
        try {
          presence = resolvePresence(config, { agentId });
        } catch (err) {
          return toolError(`Presence unresolved: ${errorMessage(err)}`);
        }

        const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
        const namespace = presence.namespaces.episodic;

        let page: EpisodicPage;
        try {
          page = await client.getWithQuery<EpisodicPage>(
            "/v1/episodic",
            { namespace, limit },
            { token: presence.token },
          );
        } catch (err) {
          return toolError(`Musubi recent failed: ${errorMessage(err)}`);
        }

        let rows: readonly EpisodicRow[] = page.items ?? [];

        // Apply tag filter — every listed tag must be in row.tags.
        if (params.tags && params.tags.length > 0) {
          const required = params.tags;
          rows = rows.filter((r) => required.every((t) => (r.tags ?? []).includes(t)));
        }

        // Apply since filter — row's primary timestamp >= since.
        if (params.since) {
          const sinceMs = Date.parse(params.since);
          if (!Number.isFinite(sinceMs)) {
            return toolError(
              `Invalid 'since' value '${params.since}': expected ISO-8601 timestamp.`,
            );
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

function pickTimestampMs(row: EpisodicRow): number | undefined {
  if (row.event_at) {
    const ms = Date.parse(row.event_at);
    if (Number.isFinite(ms)) return ms;
  }
  if (row.created_at) {
    const ms = Date.parse(row.created_at);
    if (Number.isFinite(ms)) return ms;
  }
  if (row.ingested_at) {
    const ms = Date.parse(row.ingested_at);
    if (Number.isFinite(ms)) return ms;
  }
  if (typeof row.created_epoch === "number") {
    return row.created_epoch * 1000;
  }
  return undefined;
}

function formatResults(namespace: string, rows: readonly EpisodicRow[]): string {
  const lines: string[] = [];
  lines.push(`Recent activity (${namespace}, last ${rows.length}):`);
  lines.push("");
  for (const row of rows) {
    const ts = row.event_at ?? row.created_at ?? row.ingested_at ?? "(no timestamp)";
    const oid = row.object_id ?? "<no-id>";
    const content = (row.content ?? "").trim();
    lines.push(`[${ts}] ${namespace}/${oid}`);
    if (content) lines.push(content);
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

function toolText(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function toolError(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function errorMessage(err: unknown): string {
  if (err instanceof MusubiError) return `${err.name}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}
