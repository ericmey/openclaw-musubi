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

type SharedDeliveryRuntime = {
  readonly owner: symbol;
  readonly path: string;
  readonly config: MusubiConfig;
  readonly outbox: DeliveryOutbox;
  readonly worker: DeliveryWorker;
};

type SharedDeliveryState = {
  current: SharedDeliveryRuntime | undefined;
  transition: Promise<void>;
};

const SHARED_DELIVERY_STATE = Symbol.for("openclaw-musubi.delivery-state.v1");

/**
 * Owns the durable capture boundary. Hook and tool callers only return after
 * SQLite has committed and read back the queue row; network delivery remains
 * host-service work and survives restart.
 */
export class DeliveryController {
  readonly #client: MusubiClient;
  readonly #config: MusubiConfig;
  readonly #logger: DeliveryLogger;
  readonly #createOutbox: (path: string) => DeliveryOutbox;
  #serviceOwner: symbol | undefined;

  constructor(options: {
    client: MusubiClient;
    config: MusubiConfig;
    logger: DeliveryLogger;
    createOutbox?: (path: string) => DeliveryOutbox;
  }) {
    this.#client = options.client;
    this.#config = options.config;
    this.#logger = options.logger;
    this.#createOutbox = options.createOutbox ?? ((path) => new DeliveryOutbox(path));
  }

  async start(path: string): Promise<void> {
    if (this.#serviceOwner) return;
    const owner = Symbol("musubi-delivery-owner");
    await withSharedDeliveryLock(async (state) => {
      if (this.#serviceOwner) return;
      const previous = state.current;
      const outbox = this.#createOutbox(path);
      const worker = new DeliveryWorker({
        client: this.#client,
        config: this.#config,
        outbox,
        logger: this.#logger,
      });
      try {
        if (previous) await previous.worker.stop();
        worker.start();
      } catch (error) {
        previous?.worker.start();
        outbox.close();
        throw error;
      }
      state.current = { owner, path, config: this.#config, outbox, worker };
      this.#serviceOwner = owner;
      if (previous) {
        try {
          previous.outbox.close();
        } catch (error) {
          this.#logger.warn(`musubi: superseded outbox close failed — ${errorMessage(error)}`);
        }
      }
    });
  }

  async stop(): Promise<void> {
    const owner = this.#serviceOwner;
    if (!owner) return;
    await withSharedDeliveryLock(async (state) => {
      this.#serviceOwner = undefined;
      if (state.current?.owner !== owner) return;
      const current = state.current;
      state.current = undefined;
      await closeRuntime(current);
    });
  }

  enqueueCapture(event: CaptureEvent): DeliveryRow {
    const { config, outbox, worker } = this.#requireRuntime();
    const presence = resolvePresence(config, {
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
    worker.kick();
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
    const { config, outbox, worker } = this.#requireRuntime();
    const presence = resolvePresence(config, {
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
    worker.kick();
    return row;
  }

  async awaitTerminal(rowId: number, timeoutMs = 1500): Promise<DeliveryRow | undefined> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = this.#requireRuntime();
      current.worker.kick();
      const row = current.outbox.row(rowId);
      if (!row || row.state === "verified" || row.state === "dead") return row;
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    return this.#requireRuntime().outbox.row(rowId);
  }

  status(): DeliveryControllerStatus {
    const current = sharedDeliveryState().current;
    if (!current) {
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
    return { running: true, ...current.outbox.health() };
  }

  #requireRuntime(): SharedDeliveryRuntime {
    const current = sharedDeliveryState().current;
    if (!current) {
      throw new Error("musubi: delivery service is not running; capture was not queued");
    }
    return current;
  }
}

function sharedDeliveryState(): SharedDeliveryState {
  const root = globalThis as typeof globalThis & {
    [key: symbol]: SharedDeliveryState | undefined;
  };
  let state = root[SHARED_DELIVERY_STATE];
  if (!state) {
    state = { current: undefined, transition: Promise.resolve() };
    root[SHARED_DELIVERY_STATE] = state;
  }
  return state;
}

async function withSharedDeliveryLock(
  operation: (state: SharedDeliveryState) => Promise<void>,
): Promise<void> {
  const state = sharedDeliveryState();
  const previous = state.transition;
  let release!: () => void;
  state.transition = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    await operation(state);
  } finally {
    release();
  }
}

async function closeRuntime(runtime: SharedDeliveryRuntime): Promise<void> {
  await runtime.worker.stop();
  runtime.outbox.close();
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
