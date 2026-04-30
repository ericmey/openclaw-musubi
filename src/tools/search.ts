import type { MusubiConfig } from "../config.js";
import type { MusubiClient } from "../musubi/client.js";
import { MusubiError } from "../musubi/errors.js";
import { resolvePresence } from "../presence/resolver.js";
import { buildRetrieveTargets } from "../supplement/retrieve-targets.js";
import { SearchParameters, type SearchParams } from "./parameters.js";

/**
 * Canonical agent-callable semantic search tool — `musubi_search`.
 *
 * Hybrid + rerank retrieval across every plane the calling presence can
 * read. The deep-path companion to the passive memory supplement: the
 * agent invokes this when the supplement missed the load-bearing thing,
 * or when the agent needs artifact-level grounding.
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

  let presence;
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
          namespace: t.baseNamespace,
          planes: [...t.planes],
          query_text: params.query,
          mode: "deep",
          limit,
        },
        token: presence.token,
      }),
    ),
  );
  if (settled.every((r) => r.status === "rejected")) {
    const firstErr =
      settled[0]!.status === "rejected"
        ? (settled[0] as PromiseRejectedResult).reason
        : new Error("unknown");
    return toolError(`Musubi search failed: ${errorMessage(firstErr)}`);
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
  const results = merged.slice(0, limit);
  if (results.length === 0) {
    return toolText(`No Musubi results for "${params.query}".`);
  }
  return toolText(formatResults(results));
}

export function createSearchTool(options: CreateSearchToolOptions): SearchTool {
  return {
    recommendedOptional: true,
    definition: {
      name: "musubi_search",
      description:
        "Search Musubi across every plane (curated knowledge, synthesized concepts, episodic memory, source artifacts) using the full hybrid + rerank pipeline. Use when the passive memory supplement didn't surface what you need.",
      parameters: SearchParameters,
      async execute(_toolCallId, params) {
        return executeSearch(options, params);
      },
    },
  };
}

function formatResults(rows: readonly MusubiRetrieveRow[]): string {
  const lines: string[] = [];
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
