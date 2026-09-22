import type { MusubiConfig } from "../config.js";
import type { MusubiClient } from "../musubi/client.js";
import { RecallParameters, type RecallParams } from "./parameters.js";
import { executeSearch, type ToolResult } from "./search.js";

/**
 * Deprecated agent-callable semantic search tool — `musubi_recall`.
 *
 * Per [[13-decisions/0032-agent-tools-canonical-surface]] the canonical
 * name is `musubi_search`; `musubi_recall` is a one-release deprecation
 * alias that forwards to the same body with a warning log so existing
 * system prompts keep working while we migrate. After the next minor
 * release this file goes away and `musubi_recall` stops being
 * advertised.
 */

export type ToolDefinition = {
  readonly name: string;
  readonly description: string;
  readonly parameters: typeof RecallParameters;
  execute(toolCallId: string, params: RecallParams): Promise<ToolResult>;
};

export type CreateRecallToolOptions = {
  readonly client: MusubiClient;
  readonly config: MusubiConfig;
  readonly agentId?: string;
  /**
   * Required logger so the deprecation warning surfaces through the
   * plugin host's structured-log channel. Every plugin host provides
   * one; bootstrap wires it explicitly to keep the warning inside the
   * host's redaction pipeline (tokens are never to be logged via
   * `console.*`, see SECURITY.md).
   */
  readonly logger: { warn(message: string): void };
};

export type RecallTool = {
  readonly definition: ToolDefinition;
  readonly recommendedOptional: true;
};

export function createRecallTool(options: CreateRecallToolOptions): RecallTool {
  const { logger } = options;
  return {
    recommendedOptional: true,
    definition: {
      name: "musubi_recall",
      description:
        "[DEPRECATED — use musubi_search] Search Musubi across every plane using the full hybrid + rerank pipeline. Removed in the next minor release.",
      parameters: RecallParameters,
      async execute(_toolCallId, params) {
        logger.warn(
          "musubi_recall is deprecated; use musubi_search (canonical name per ADR 0032 / agent-tools spec). The alias drops in the next minor release.",
        );
        return executeSearch(options, params);
      },
    },
  };
}
