import { createHash } from "node:crypto";

import type { CaptureEvent } from "../capture/translate.js";
import {
  deriveIdempotencyKey,
  toCanonicalCapture,
  translateCaptureEvent,
} from "../capture/translate.js";
import type { MusubiConfig } from "../config.js";
import type { MusubiClient } from "../musubi/client.js";
import { resolvePresence } from "../presence/resolver.js";
import { DeliveryOutbox, type DeliveryRow, type OutboxHealth } from "./outbox.js";
import { DeliveryWorker } from "./worker.js";

type DeliveryLogger = {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  debug?(message: string): void;
};

export type DeliveryControllerStatus = OutboxHealth & {
  readonly running: boolean;
};

/**
 * Owns the durable capture boundary. Hook and tool callers only return after
 * SQLite has committed and read back the queue row; network delivery remains
 * host-service work and survives restart.
 */
export class DeliveryController {
  readonly #client: MusubiClient;
  readonly #config: MusubiConfig;
  readonly #logger: DeliveryLogger;
  #outbox: DeliveryOutbox | undefined;
  #worker: DeliveryWorker | undefined;

  constructor(options: {
    client: MusubiClient;
    config: MusubiConfig;
    logger: DeliveryLogger;
  }) {
    this.#client = options.client;
    this.#config = options.config;
    this.#logger = options.logger;
  }

  start(path: string): void {
    if (this.#outbox || this.#worker) return;
    const outbox = new DeliveryOutbox(path);
    try {
      const worker = new DeliveryWorker({
        client: this.#client,
        config: this.#config,
        outbox,
        logger: this.#logger,
      });
      this.#outbox = outbox;
      this.#worker = worker;
      worker.start();
    } catch (error) {
      this.#outbox = undefined;
      this.#worker = undefined;
      outbox.close();
      throw error;
    }
  }

  async stop(): Promise<void> {
    const worker = this.#worker;
    const outbox = this.#outbox;
    this.#worker = undefined;
    this.#outbox = undefined;
    if (worker) await worker.stop();
    outbox?.close();
  }

  enqueueCapture(event: CaptureEvent): DeliveryRow {
    const outbox = this.#requireOutbox();
    const presence = resolvePresence(this.#config, {
      agentId: event.agentId,
      strict: event.agentId !== undefined,
    });
    const payload = translateCaptureEvent(event, presence);
    const canonical = toCanonicalCapture(payload);
    const row = outbox.enqueue({
      idempotencyKey: deriveIdempotencyKey(event),
      contentSha256: sha256(canonical.content),
      namespace: canonical.namespace,
      agentId: event.agentId,
      content: canonical.content,
      tags: canonical.tags,
      importance: canonical.importance,
      sourceRef: event.id,
    });
    this.#worker?.kick();
    return row;
  }

  enqueueExplicit(options: {
    readonly agentId?: string;
    readonly toolCallId: string;
    readonly content: string;
    readonly importance: number;
    readonly topics: readonly string[];
    readonly idempotencyKey: string;
  }): DeliveryRow {
    const outbox = this.#requireOutbox();
    const presence = resolvePresence(this.#config, {
      agentId: options.agentId,
      strict: options.agentId !== undefined,
    });
    const tags = [...options.topics, "src:openclaw-agent-remember", `ref:${options.toolCallId}`];
    const row = outbox.enqueue({
      idempotencyKey: options.idempotencyKey,
      contentSha256: sha256(options.content),
      namespace: presence.namespaces.episodic,
      agentId: options.agentId,
      content: options.content,
      tags,
      importance: options.importance,
      sourceRef: options.toolCallId,
    });
    this.#worker?.kick();
    return row;
  }

  awaitTerminal(rowId: number, timeoutMs?: number): Promise<DeliveryRow | undefined> {
    const worker = this.#worker;
    if (!worker) throw new Error("musubi: delivery service is not running");
    return worker.awaitTerminal(rowId, timeoutMs);
  }

  status(): DeliveryControllerStatus {
    if (!this.#outbox) {
      return {
        running: false,
        pending: 0,
        dead: 0,
        oldestPendingAgeMs: 0,
        consecutiveFailures: 0,
        lastVerifiedAtMs: null,
        degraded: true,
      };
    }
    return { running: true, ...this.#outbox.health() };
  }

  #requireOutbox(): DeliveryOutbox {
    if (!this.#outbox) {
      throw new Error("musubi: delivery service is not running; capture was not queued");
    }
    return this.#outbox;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
