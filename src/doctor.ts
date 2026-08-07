import { randomUUID } from "node:crypto";

import type { MusubiConfig } from "./config.js";
import type { DeliveryController } from "./delivery/controller.js";
import type { MusubiClient } from "./musubi/client.js";
import { resolvePresence } from "./presence/resolver.js";

const RECALL_STATES = ["provisional", "matured", "promoted"] as const;

type RetrieveResponse = {
  readonly results?: ReadonlyArray<{ readonly object_id?: unknown }>;
  readonly warnings?: readonly unknown[];
};

export type DoctorResult = {
  readonly ok: boolean;
  readonly agentId?: string;
  readonly namespace: string;
  readonly objectId?: string;
  readonly stages: readonly string[];
  readonly error?: string;
  readonly cleanup: "archived" | "not-created" | "failed";
};

/**
 * Exercise the real provider path: durable local enqueue, worker delivery,
 * canonical GET verification, semantic retrieval, then soft-archive cleanup.
 * This is deliberately explicit operator work and never runs at startup.
 */
export async function runDeepDoctor(options: {
  readonly client: MusubiClient;
  readonly config: MusubiConfig;
  readonly delivery: DeliveryController;
  readonly agentId?: string;
}): Promise<DoctorResult> {
  const presence = resolvePresence(options.config, {
    agentId: options.agentId,
    strict: options.agentId !== undefined,
  });
  const nonce = randomUUID();
  const content = `OpenClaw Musubi doctor probe ${nonce}`;
  const stages: string[] = [];
  let objectId: string | undefined;
  let cleanup: DoctorResult["cleanup"] = "not-created";
  let failure: string | undefined;

  try {
    const row = options.delivery.enqueueExplicit({
      agentId: options.agentId,
      toolCallId: `doctor:${nonce}`,
      content,
      importance: 1,
      topics: ["diagnostic", "openclaw-musubi-doctor"],
      idempotencyKey: `openclaw-musubi-doctor-${nonce}`,
    });
    stages.push("queued");
    const terminal = await options.delivery.awaitTerminal(row.id, 15_000);
    objectId = terminal?.object_id ?? undefined;
    if (terminal?.state !== "verified" || !terminal.object_id) {
      throw new Error(
        `delivery did not verify (state=${terminal?.state ?? "missing"}, error=${terminal?.last_error ?? "none"})`,
      );
    }
    stages.push("canonical-readback-verified");

    const retrieval = await options.client.post<RetrieveResponse>("/v1/retrieve", {
      body: {
        namespace: presence.namespaces.episodic,
        planes: ["episodic"],
        query_text: content,
        mode: "deep",
        limit: 10,
        state_filter: [...RECALL_STATES],
      },
      token: presence.token,
    });
    if (!Array.isArray(retrieval.results) || (retrieval.warnings?.length ?? 0) > 0) {
      throw new Error("retrieval returned an invalid or degraded envelope");
    }
    if (!retrieval.results.some((result) => result.object_id === objectId)) {
      throw new Error("verified object was not returned by semantic retrieval");
    }
    stages.push("semantic-retrieval-verified");
  } catch (error) {
    failure = errorMessage(error);
  } finally {
    if (objectId) {
      try {
        await options.client.delete(`/v1/episodic/${encodeURIComponent(objectId)}`, {
          query: { namespace: presence.namespaces.episodic },
          token: presence.token,
        });
        cleanup = "archived";
      } catch {
        cleanup = "failed";
      }
    }
  }
  if (cleanup === "failed") {
    failure = failure ? `${failure}; diagnostic cleanup failed` : "diagnostic cleanup failed";
  }
  return {
    ok: failure === undefined,
    agentId: options.agentId,
    namespace: presence.namespaces.episodic,
    objectId,
    stages,
    error: failure,
    cleanup,
  };
}

export function formatDoctor(result: DoctorResult): string {
  const lines = [
    `Musubi doctor: ${result.ok ? "PASS" : "FAIL"}`,
    `agent=${result.agentId ?? "default"} namespace=${result.namespace}`,
    `stages=${result.stages.join(",") || "none"}`,
    `cleanup=${result.cleanup}`,
  ];
  if (result.objectId) lines.push(`object_id=${result.objectId}`);
  if (result.error) lines.push(`error=${result.error}`);
  return lines.join("\n");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
