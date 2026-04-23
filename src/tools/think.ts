import type { MusubiConfig } from "../config.js";
import type { MusubiClient } from "../musubi/client.js";
import { MusubiError } from "../musubi/errors.js";
import { resolvePresence } from "../presence/resolver.js";
import { ThinkParameters, type ThinkParams } from "./parameters.js";

/**
 * Agent-callable presence-to-presence thought send.
 *
 * "Tell my Claude Code session that the deploy is done" becomes a
 * concrete `POST /v1/thoughts/send` with `from_presence` derived from
 * the sending agent's presence context. Recipients receive it in
 * real-time via the SSE thought-stream (slice #7) — no polling needed.
 */

export type ToolDefinition = {
  readonly name: string;
  readonly description: string;
  readonly parameters: typeof ThinkParameters;
  execute(
    toolCallId: string,
    params: ThinkParams,
  ): Promise<{ content: ReadonlyArray<{ type: "text"; text: string }>; isError?: boolean }>;
};

export type CreateThinkToolOptions = {
  readonly client: MusubiClient;
  readonly config: MusubiConfig;
  readonly agentId?: string;
};

export type ThinkTool = {
  readonly definition: ToolDefinition;
  readonly recommendedOptional: true;
};

const DEFAULT_CHANNEL = "default";
const DEFAULT_IMPORTANCE = 5;

export function createThinkTool(options: CreateThinkToolOptions): ThinkTool {
  const { client, config, agentId } = options;

  return {
    recommendedOptional: true,
    definition: {
      name: "musubi_think",
      description:
        "Send a thought to another presence (agent, modality, or human endpoint). The recipient sees it in real-time via their thought stream. Use for cross-modality coordination: tell your CLI session the deploy finished, tell a voice agent to call back later, etc.",
      parameters: ThinkParameters,
      async execute(_toolCallId, params) {
        let presence;
        try {
          presence = resolvePresence(config, { agentId });
        } catch (err) {
          return errorResult(`Presence unresolved: ${errorMessage(err)}`);
        }

        try {
          const response = await client.post<{ object_id?: string }>("/v1/thoughts/send", {
            body: {
              // Canonical ThoughtSendRequest requires a 3-segment
              // `tenant/presence/thought` namespace. Plugin used to
              // pass `presence.presence` (2 segments) which the
              // server 403s as out-of-scope.
              namespace: presence.namespaces.thought,
              from_presence: presence.presence,
              to_presence: params.toPresence,
              content: params.content,
              channel: params.channel ?? DEFAULT_CHANNEL,
              importance: params.importance ?? DEFAULT_IMPORTANCE,
            },
          });

          const storedId = response?.object_id ?? "(no id)";
          return successResult(
            `Thought sent from ${presence.presence} to ${params.toPresence} — id ${storedId}.`,
          );
        } catch (err) {
          return errorResult(`Musubi think failed: ${errorMessage(err)}`);
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
