import type { MusubiConfig } from "../config.js";
import type { MusubiClient } from "../musubi/client.js";
import { MusubiError } from "../musubi/errors.js";
import { type PresenceContext, resolvePresence } from "../presence/resolver.js";
import { RecentParameters, type RecentParams } from "./parameters.js";

/**
 * Agent-callable recency-anchored episodic recall — `musubi_recent`.
 *
 * The agent asks "what's recent?" without supplying a query. Returns
 * the most recently captured episodic rows from the calling presence's
 * stream, ordered newest-first.
 *
 * **Scope today is presence-only** (`<tenant>/<presence>/episodic`).
 * Cross-modal scope (`<tenant>/*\/episodic`) still waits on
 * `slice-api-retrieve-wildcards` (Musubi #266).
 *
 * This calls `POST /v1/retrieve` with `mode="recent"` — the query-free
 * recency pipeline from `slice-retrieve-recent` (Musubi #288), which has
 * since shipped. That matters for correctness, not just tidiness: `tags`
 * (AND semantics) and `since` are SERVER-side filters there, applied
 * across the whole namespace. The previous fallback listed
 * `GET /v1/episodic?limit=...` and filtered the returned page in
 * process — and because that endpoint's page order is Qdrant scroll
 * order rather than recency, a filter could silently miss matches that
 * simply were not on the page. A memory tool reporting "nothing" when
 * the memory exists is the one failure mode this surface cannot have.
 *
 * `since` goes on the wire as epoch SECONDS (`RetrieveQuery.since` is a
 * float; the server explicitly rejects ISO strings), while the tool's
 * own parameter stays ISO-8601 for the agent. Recent rows carry
 * `score_kind: "created_epoch"`, i.e. `score` IS the source timestamp,
 * so no per-row date enrichment is needed here.
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
const RECALL_STATES = ["provisional", "matured", "promoted"] as const;

type RecentRow = {
  readonly object_id?: unknown;
  readonly namespace?: unknown;
  readonly content?: unknown;
  readonly score?: unknown;
  readonly title?: unknown;
  readonly content_truncated?: unknown;
  readonly content_length?: unknown;
};

type RecentResponse = {
  readonly mode?: unknown;
  readonly results?: readonly RecentRow[];
  readonly warnings?: readonly unknown[];
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
        let presence: PresenceContext;
        try {
          presence = resolvePresence(config, { agentId });
        } catch (err) {
          return toolError(`Presence unresolved: ${errorMessage(err)}`);
        }

        const limit = Math.min(Math.max(params.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
        const namespace = presence.namespaces.episodic;

        let since: number | undefined;
        if (params.since) {
          const sinceMs = Date.parse(params.since);
          if (!Number.isFinite(sinceMs)) {
            return toolError(
              `Invalid 'since' value '${params.since}': expected ISO-8601 timestamp.`,
            );
          }
          // The wire field is epoch seconds; ISO strings are rejected server-side.
          since = sinceMs / 1000;
        }

        const tags = params.tags && params.tags.length > 0 ? [...params.tags] : undefined;

        let response: RecentResponse;
        try {
          response = await client.post<RecentResponse>("/v1/retrieve", {
            body: {
              namespace,
              planes: ["episodic"],
              mode: "recent",
              limit,
              state_filter: [...RECALL_STATES],
              ...(tags ? { tags } : {}),
              ...(since !== undefined ? { since } : {}),
            },
            token: presence.token,
          });
        } catch (err) {
          return toolError(`Musubi recent failed: ${errorMessage(err)}`);
        }

        if (response?.mode !== "recent" || !Array.isArray(response.results)) {
          return toolError("Musubi recent returned an unexpected envelope; no rows were surfaced.");
        }

        const warnings = (response.warnings ?? []).map(
          (warning) => `Musubi warning: ${formatWarning(warning)}`,
        );

        const rows: RecentRow[] = [];
        for (const row of response.results) {
          // The request carries an explicit namespace, so the server rejects
          // rather than filters an out-of-scope target — but a row from
          // somewhere else would still mean the token authenticates another
          // identity. Fail the call closed rather than surface it. See ADR-0005.
          if (row.namespace !== namespace) {
            return toolError(
              `Musubi identity boundary violation: recent returned namespace ` +
                `"${String(row.namespace)}" for a request scoped to "${namespace}". ` +
                "No results were surfaced. Check the token bound to this agent in " +
                "plugins.entries.musubi.config.core.perAgentTokens before retrying.",
            );
          }
          rows.push(row);
        }

        if (rows.length === 0) {
          return toolText(appendWarnings(`No recent activity in ${namespace}.`, warnings));
        }
        // `score` is created_epoch for recent rows; newest-first regardless of
        // the order the pipeline happened to emit.
        rows.sort((a, b) => epochOf(b) - epochOf(a));
        return toolText(appendWarnings(formatResults(namespace, rows), warnings));
      },
    },
  };
}

function epochOf(row: RecentRow): number {
  return typeof row.score === "number" && Number.isFinite(row.score) ? row.score : 0;
}

function formatResults(namespace: string, rows: readonly RecentRow[]): string {
  const lines: string[] = [];
  lines.push(`Recent activity (${namespace}, last ${rows.length}):`);
  lines.push("");
  for (const row of rows) {
    const epoch = epochOf(row);
    const ts = epoch > 0 ? new Date(epoch * 1000).toISOString() : "(no timestamp)";
    const oid = typeof row.object_id === "string" ? row.object_id : "<no-id>";
    const content = typeof row.content === "string" ? row.content.trim() : "";
    lines.push(`[${ts}] ${namespace}/${oid}`);
    if (content) lines.push(content);
    // The server slices long content and flags the cut (DQ-001). Rendering a
    // slice as if it were the whole row invites the agent to speak about
    // source it has not actually seen.
    if (row.content_truncated === true) {
      const full = typeof row.content_length === "number" ? ` of ${row.content_length} chars` : "";
      lines.push(`[content truncated${full} — use musubi_get for the full object]`);
    }
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

function formatWarning(warning: unknown): string {
  if (typeof warning === "string") return warning;
  try {
    return JSON.stringify(warning);
  } catch {
    return String(warning);
  }
}

function appendWarnings(text: string, warnings: readonly string[]): string {
  if (warnings.length === 0) return text;
  return `${text}\n\nRetrieval warnings:\n${warnings.map((warning) => `- ${warning}`).join("\n")}`;
}
