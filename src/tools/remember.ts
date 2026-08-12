import type { DeliveryController } from "../delivery/controller.js";
import { RememberParameters, type RememberParams } from "./parameters.js";

/**
 * Agent-callable explicit episodic capture.
 *
 * Completed turns are durably captured from `agent_end` at neutral
 * importance (5). `remember` is the
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
  readonly delivery: Pick<DeliveryController, "enqueueExplicit" | "awaitTerminal">;
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
export function createRememberTool(options: CreateRememberToolOptions): RememberTool {
  const { delivery, agentId } = options;

  return {
    recommendedOptional: true,
    definition: {
      name: "musubi_remember",
      description:
        "Explicitly store something in the active Musubi memory provider. Use for load-bearing decisions, facts, commitments, and observations. The result distinguishes queued from canonically verified delivery.",
      parameters: RememberParameters,
      async execute(toolCallId, params) {
        try {
          const row = delivery.enqueueExplicit({
            agentId,
            toolCallId,
            content: params.content,
            importance: params.importance ?? DEFAULT_IMPORTANCE,
            topics: params.topics ?? [],
            idempotencyKey: params.idempotencyKey ?? `openclaw-remember:${toolCallId}`,
          });
          const terminal = await delivery.awaitTerminal(row.id);
          if (terminal?.state === "verified" && terminal.object_id) {
            return successResult(
              `Verified in Musubi (${terminal.namespace}) — id ${terminal.object_id}; receipt ${terminal.idem_key}.`,
            );
          }
          if (terminal?.state === "dead") {
            return errorResult(
              `Musubi rejected the durable delivery. Receipt ${terminal.idem_key}; ${terminal.last_error ?? "no error detail"}.`,
            );
          }
          return successResult(
            `Queued durably for Musubi delivery (${row.namespace}); receipt ${row.idem_key}. Storage is not yet verified.`,
          );
        } catch (err) {
          return errorResult(`Musubi remember was not queued: ${errorMessage(err)}`);
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
  if (err instanceof Error) return err.message;
  return String(err);
}
