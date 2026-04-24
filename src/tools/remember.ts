import type { MusubiConfig } from "../config.js";
import type { MusubiClient } from "../musubi/client.js";
import { MusubiError } from "../musubi/errors.js";
import { resolvePresence } from "../presence/resolver.js";
import { RememberParameters, type RememberParams } from "./parameters.js";

/**
 * Agent-callable explicit episodic capture.
 *
 * The capture-mirror from slice #6 passively mirrors `agent_end` events
 * into Musubi episodic at neutral importance (5). `remember` is the
 * explicit "this matters" path — higher default importance, optional
 * topics, and an optional client-supplied idempotency key for when the
 * agent is recording something with a stable identity (e.g. referencing
 * an external issue id).
 */

export type ToolDefinition = {
  readonly name: string;
  readonly description: string;
  readonly parameters: typeof RememberParameters;
  execute(
    toolCallId: string,
    params: RememberParams,
  ): Promise<{ content: ReadonlyArray<{ type: "text"; text: string }>; isError?: boolean }>;
};

export type CreateRememberToolOptions = {
  readonly client: MusubiClient;
  readonly config: MusubiConfig;
  readonly agentId?: string;
  /**
   * Optional clock override — retained for test-fixture compatibility.
   * Not consulted by the current canonical-shape body (which lets the
   * server assign `created_at` on ingest); kept for back-compat with
   * callers that still pass one.
   */
  readonly now?: () => Date;
};

export type RememberTool = {
  readonly definition: ToolDefinition;
  readonly recommendedOptional: true;
};

const DEFAULT_IMPORTANCE = 7;
const CAPTURE_SOURCE = "openclaw-agent-remember";

export function createRememberTool(options: CreateRememberToolOptions): RememberTool {
  const { client, config, agentId } = options;

  return {
    recommendedOptional: true,
    definition: {
      name: "musubi_remember",
      description:
        "Explicitly capture something into Musubi's episodic memory. Use for things the agent judges as load-bearing — decisions, facts, commitments, observations. Passive capture already mirrors every turn; use this for higher-signal items.",
      parameters: RememberParameters,
      async execute(toolCallId, params) {
        let presence;
        try {
          presence = resolvePresence(config, { agentId });
        } catch (err) {
          return errorResult(`Presence unresolved: ${errorMessage(err)}`);
        }

        const idempotencyKey = params.idempotencyKey ?? `openclaw-remember:${toolCallId}`;

        try {
          const response = await client.post<{ object_id?: string }>("/v1/memories", {
            // Canonical `CaptureRequest` (Musubi v0.4.0) accepts
            // {namespace, content, summary?, tags, importance, created_at?}.
            // Audit metadata folds into `tags` with prefixes so it
            // round-trips without requiring a canonical API extension;
            // see `src/capture/translate.ts::toCanonicalCapture` for
            // the matching shape used by the passive capture mirror.
            body: {
              namespace: presence.namespaces.episodic,
              content: params.content,
              importance: params.importance ?? DEFAULT_IMPORTANCE,
              tags: [
                ...(params.topics ?? []),
                `src:${CAPTURE_SOURCE}`,
                `ref:${toolCallId}`,
              ],
            },
            idempotencyKey,
            token: presence.token,
          });

          const storedId = response?.object_id ?? "(no id)";
          return successResult(
            `Remembered in Musubi episodic (${presence.namespaces.episodic}) — id ${storedId}.`,
          );
        } catch (err) {
          return errorResult(`Musubi remember failed: ${errorMessage(err)}`);
        }
      },
    },
  };
}

function successResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

function errorMessage(err: unknown): string {
  if (err instanceof MusubiError) return `${err.name}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}
