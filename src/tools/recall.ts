import type { MusubiConfig } from "../config.js";
import type { MusubiClient } from "../musubi/client.js";
import { MusubiError } from "../musubi/errors.js";
import { resolvePresence } from "../presence/resolver.js";
import { buildRetrieveTargets } from "../supplement/retrieve-targets.js";
import { RecallParameters, type RecallParams } from "./parameters.js";

/**
 * Agent-callable deep-path retrieval across all planes.
 *
 * The passive `MemoryCorpusSupplement` from slice #4 covers the common
 * case (query-relevant curated + concept rows in fast mode). `recall` is
 * the explicit escape hatch when the supplement missed, or when the
 * agent knows it wants the full hybrid + rerank pipeline across every
 * plane including episodic and artifacts.
 */

export type ToolDefinition = {
  readonly name: string;
  readonly description: string;
  readonly parameters: typeof RecallParameters;
  execute(toolCallId: string, params: RecallParams): Promise<ToolResult>;
};

export type ToolResult = {
  readonly content: ReadonlyArray<{ type: "text"; text: string }>;
  readonly isError?: boolean;
};

export type CreateRecallToolOptions = {
  readonly client: MusubiClient;
  readonly config: MusubiConfig;
  /** OpenClaw agent id for presence resolution. */
  readonly agentId?: string;
};

export type RecallTool = {
  readonly definition: ToolDefinition;
  /** Hint to the wiring slice: this tool is opt-in per-agent, not required. */
  readonly recommendedOptional: true;
};

const DEFAULT_LIMIT = 10;

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

export function createRecallTool(options: CreateRecallToolOptions): RecallTool {
  const { client, config, agentId } = options;

  return {
    recommendedOptional: true,
    definition: {
      name: "musubi_recall",
      description:
        "Search Musubi across every plane (curated knowledge, synthesized concepts, episodic memory, source artifacts) using the full hybrid + rerank pipeline. Use when the passive memory supplement didn't surface what you need.",
      parameters: RecallParameters,
      async execute(_toolCallId, params) {
        let presence;
        try {
          presence = resolvePresence(config, { agentId });
        } catch (err) {
          return toolError(`Presence unresolved: ${errorMessage(err)}`);
        }

        const limit = params.limit ?? DEFAULT_LIMIT;

        // Build planes list from caller filter or default readable set.
        const defaultPlanes = ["curated", "concept", "episodic", "artifact"];
        const callerPlanes = params.planes ? [...params.planes] : defaultPlanes;

        // Collapse per-plane fanout into 2-segment cross-plane calls.
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
          return toolError(`Musubi recall failed: ${errorMessage(firstErr)}`);
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
      },
    },
  };
}

function formatResults(rows: readonly MusubiRetrieveRow[]): string {
  const lines: string[] = [];
  lines.push(`Musubi returned ${rows.length} result(s):`);
  lines.push("");
  for (const row of rows) {
    lines.push(`[${row.plane}] (score ${row.score.toFixed(2)}) ${row.namespace}/${row.object_id}`);
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
