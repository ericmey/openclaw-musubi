import type { MusubiConfig } from "../config.js";
import type { MusubiClient } from "../musubi/client.js";
import { MusubiError } from "../musubi/errors.js";
import { type PresenceContext, resolvePresence } from "../presence/resolver.js";
import { buildRetrieveTargets } from "../retrieval/targets.js";
import { SearchParameters, type SearchParams } from "./parameters.js";

/**
 * Canonical agent-callable semantic search tool — `musubi_search`.
 *
 * Hybrid + rerank retrieval across every plane the calling presence can
 * read. This is the native first-class recall path; the agent invokes it when
 * prior continuity may matter or when artifact-level grounding is needed.
 *
 * This file holds the body. `recall.ts` re-exports the same body wrapped
 * with a deprecation log under the legacy `musubi_recall` name for
 * one minor release per [[13-decisions/0032-agent-tools-canonical-surface]].
 */

export type ToolDefinition = {
  readonly name: string;
  readonly description: string;
  readonly parameters: typeof SearchParameters;
  execute(toolCallId: string, params: SearchParams): Promise<ToolResult>;
};

export type ToolResult = {
  readonly content: ReadonlyArray<{ type: "text"; text: string }>;
  readonly isError?: boolean;
};

export type CreateSearchToolOptions = {
  readonly client: MusubiClient;
  readonly config: MusubiConfig;
  /** OpenClaw agent id for presence resolution. */
  readonly agentId?: string;
};

export type SearchTool = {
  readonly definition: ToolDefinition;
  readonly recommendedOptional: true;
};

const DEFAULT_LIMIT = 10;

/**
 * Below this top score, candidate CONTENT is withheld entirely.
 *
 * Initial safety floor, not a tuned value. On 2026-08-07 a failed recall query
 * against Mizuki's namespace returned a flat plateau topping out at 0.54; later
 * corpus inspection showed that plateau was dominated by duplicate OpenClaw
 * heartbeat probes, not wrong-week human memories. The incident proves that
 * weak machine-noise candidates must be withheld, but it does NOT calibrate
 * relevance for clean human memories. Keep 0.60 as a conservative provisional
 * floor until known-answer queries against the cleaned corpus measure both
 * genuine matches and genuine near-misses.
 *
 * Deliberately asymmetric: a false miss is recoverable by rephrasing the
 * question. Fabricated episodic certainty is not -- it becomes something a
 * person believes they lived. Do not lower it on intuition.
 */
const STRONG_MATCH_MIN_SCORE = 0.6;

/** Same per-plane paths get.ts uses; retrieval carries no date of its own. */
const PLANE_PATH: Record<string, string> = {
  curated: "/v1/curated",
  concept: "/v1/concepts",
  episodic: "/v1/episodic",
  artifact: "/v1/artifacts",
};

type DatedRow = MusubiRetrieveRow & { readonly created_at?: string };
type DateEnrichment = {
  readonly rows: readonly DatedRow[];
  readonly warnings: readonly string[];
};

/**
 * Attach each candidate's real source date.
 *
 * `/v1/retrieve` returns object_id, namespace, plane, score, content, state,
 * importance, score_kind, extra and title -- verified against the live API on
 * 2026-08-07, not merely against our own type. There is no date on the wire and
 * `extra` holds only lineage and score_components, so a date cannot be surfaced
 * by typing an existing field; it has to be fetched.
 *
 * Why this matters: asked about one week and handed memories from another, the
 * model had NO field that distinguished them. We required a judgement we never
 * gave it the information to make. Enrichment is bounded by `limit` and each
 * failure degrades to "date unavailable" -- never to a guess, and never to
 * silently omitting the date, which is the state that caused this.
 */
async function withDates(
  rows: readonly MusubiRetrieveRow[],
  client: MusubiClient,
  token: string,
): Promise<DateEnrichment> {
  const enriched = await Promise.all(
    rows.map(async (row) => {
      const base = PLANE_PATH[row.plane];
      if (!base) {
        return {
          row,
          warning: `date metadata unavailable for unsupported plane ${row.plane} (${row.namespace}/${row.object_id})`,
        };
      }
      try {
        const full = await client.getWithQuery<{ created_at?: string; event_at?: string }>(
          `${base}/${encodeURIComponent(row.object_id)}`,
          { namespace: row.namespace },
          { token },
        );
        // `created_at` is the lived/source chronology. Historical imports keep
        // that original timestamp while `event_at` records the later ingestion
        // lifecycle event. Prefer the source date so an old memory does not
        // present itself as something that happened during tonight's import.
        return { row: { ...row, created_at: full.created_at ?? full.event_at } };
      } catch (err) {
        return {
          row,
          warning: `date metadata unavailable for ${row.plane} ${row.namespace}/${row.object_id}: ${errorMessage(err)}`,
        };
      }
    }),
  );
  return {
    rows: enriched.map((entry) => entry.row),
    warnings: enriched.flatMap((entry) => (entry.warning ? [entry.warning] : [])),
  };
}

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
  readonly warnings?: readonly unknown[];
};

const RECALL_STATES = ["provisional", "matured", "promoted"] as const;

/**
 * Backing implementation. Exported so the deprecation alias in
 * `recall.ts` reuses the exact same code path — no parameter or
 * response drift between canonical and alias.
 */
export async function executeSearch(
  options: CreateSearchToolOptions,
  params: SearchParams,
): Promise<ToolResult> {
  const { client, config, agentId } = options;

  let presence: PresenceContext;
  try {
    presence = resolvePresence(config, { agentId });
  } catch (err) {
    return toolError(`Presence unresolved: ${errorMessage(err)}`);
  }

  const limit = params.limit ?? DEFAULT_LIMIT;
  const defaultPlanes = ["curated", "concept", "episodic", "artifact"];
  const callerPlanes = params.planes ? [...params.planes] : defaultPlanes;
  const targets = buildRetrieveTargets(presence, callerPlanes);

  const settled = await Promise.allSettled(
    targets.map((t) =>
      client.post<MusubiRetrieveResponse>("/v1/retrieve", {
        body: {
          // `namespace` is deliberately omitted for undefined targets:
          // the server's family-discovery path filters unauthorized
          // namespaces instead of 403ing the whole request the way an
          // explicit wildcard does. See retrieval/targets.ts.
          ...(t.namespace !== undefined ? { namespace: t.namespace } : {}),
          planes: [...t.planes],
          query_text: params.query,
          mode: "deep",
          limit,
          state_filter: [...RECALL_STATES],
        },
        token: presence.token,
      }),
    ),
  );
  if (settled.every((r) => r.status === "rejected")) {
    const firstErr =
      settled[0]?.status === "rejected"
        ? (settled[0] as PromiseRejectedResult).reason
        : new Error("unknown");
    return toolError(`Musubi search failed: ${errorMessage(firstErr)}`);
  }
  const seen = new Set<string>();
  const merged: MusubiRetrieveRow[] = [];
  const warnings: string[] = [];
  const expectedOwner = targets[0]?.expectedOwner;
  for (const result of settled) {
    if (result.status !== "fulfilled") {
      warnings.push(`one retrieval target failed: ${errorMessage(result.reason)}`);
      continue;
    }
    for (const warning of result.value.warnings ?? []) {
      warnings.push(`Musubi warning: ${formatWarning(warning)}`);
    }
    for (const row of result.value.results ?? []) {
      // IDENTITY BOUNDARY — the FIRST statement in the row loop, before
      // any downstream content handling: the row is never merged,
      // surfaced, or logged. (The HTTP body was necessarily JSON-parsed
      // by the client before this loop; the guarantee is about what
      // happens to row content after that.) No-namespace retrieval lets
      // the server derive the identity family from the presented token
      // alone, so a credential misbinding (this agent configured with
      // another agent's token) would otherwise SUCCEED and hand this
      // agent someone else's memories. A single foreign row fails the
      // entire call — no partial success, no silent dropping — so
      // operators see the misbinding instead of the agents quietly
      // sharing a mind.
      const rowNamespace = typeof row.namespace === "string" ? row.namespace : "";
      const rowOwner = rowNamespace.split("/", 1)[0];
      if (expectedOwner === undefined || rowOwner !== expectedOwner) {
        return toolError(
          `Musubi identity boundary violation: retrieval returned namespace ` +
            `"${rowNamespace}" outside the configured identity "${expectedOwner ?? "?"}/…". ` +
            `No results were surfaced. This means the token bound to this agent ` +
            `authenticates a DIFFERENT identity family — check ` +
            `plugins.entries.musubi.config.core.perAgentTokens for this agent before retrying.`,
        );
      }
      if (seen.has(row.object_id)) continue;
      seen.add(row.object_id);
      merged.push(row);
    }
  }
  merged.sort((a, b) => b.score - a.score);
  const results = merged.slice(0, limit);
  if (results.length === 0) {
    const status =
      warnings.length > 0
        ? "No results were returned; retrieval was degraded."
        : `No Musubi results for "${params.query}".`;
    return toolText(appendWarnings(status, warnings));
  }
  const top = results[0]?.score ?? 0;
  if (top < STRONG_MATCH_MIN_SCORE) {
    // FAIL CLOSED. Withhold content, not just confidence. Showing weak
    // candidates alongside a caveat still puts plausible text in front of the
    // model, and that is precisely what got promoted into a claimed event.
    return toolText(
      appendWarnings(
        `NO STRONG MATCH for "${params.query}" (top similarity ${top.toFixed(2)}, ` +
          `floor ${STRONG_MATCH_MIN_SCORE.toFixed(2)}). ${results.length} weak ` +
          `candidate(s) were withheld: they are nearest neighbours, not evidence ` +
          `that any specific event occurred. Say you do not remember, or ask for ` +
          `a more specific detail and search again.`,
        warnings,
      ),
    );
  }
  const dated = await withDates(results, client, presence.token);
  return toolText(appendWarnings(formatResults(dated.rows), [...warnings, ...dated.warnings]));
}

export function createSearchTool(options: CreateSearchToolOptions): SearchTool {
  return {
    recommendedOptional: true,
    definition: {
      name: "musubi_search",
      description:
        "Search the active Musubi memory provider across every readable plane (curated knowledge, synthesized concepts, episodic memory, source artifacts) using hybrid retrieval and reranking.",
      parameters: SearchParameters,
      async execute(_toolCallId, params) {
        return executeSearch(options, params);
      },
    },
  };
}

function formatResults(rows: readonly DatedRow[]): string {
  const lines: string[] = [];
  lines.push(`Musubi returned ${rows.length} result(s):`);
  lines.push("");
  for (const row of rows) {
    const label = row.title ? `${row.title}` : `${row.namespace}/${row.object_id}`;
    const when = row.created_at ? row.created_at.slice(0, 10) : "date unavailable";
    lines.push(`[${row.plane}] (${when}) (score ${row.score.toFixed(2)}) ${label}`);
    lines.push(row.content);
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
