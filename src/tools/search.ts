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
          namespace: t.baseNamespace,
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
  for (const result of settled) {
    if (result.status !== "fulfilled") {
      warnings.push(`one retrieval target failed: ${errorMessage(result.reason)}`);
      continue;
    }
    for (const warning of result.value.warnings ?? []) {
      warnings.push(`Musubi warning: ${formatWarning(warning)}`);
    }
    for (const row of result.value.results ?? []) {
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
  return toolText(appendWarnings(formatResults(results), warnings));
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
