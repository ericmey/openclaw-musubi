import type { MusubiConfig } from "../config.js";
import type { MusubiClient } from "../musubi/client.js";
import { resolvePresence } from "../presence/resolver.js";
import {
  deriveIdempotencyKey,
  translateCaptureEvent,
  type CaptureEvent,
  type EpisodicCapturePayload,
} from "./translate.js";

/**
 * Capture-mirror — translates capture-eligible events from OpenClaw's
 * lifecycle hooks (today `agent_end`) into Musubi episodic memories so
 * every captured turn lands in the cross-modality pool automatically.
 *
 * **Failures must never block OpenClaw.** A Musubi mirror failure is
 * logged and swallowed; OpenClaw's native memory write is unaffected.
 *
 * The mirror module exposes `handleEvent` and `handleBatch`. The wiring
 * slice (a future work item) registers these via `api.on("agent_end", …)`
 * — consistent with the pattern used by `extensions/memory-lancedb`.
 */

export type MirrorLogger = {
  warn(message: string, fields?: Record<string, unknown>): void;
  debug?(message: string, fields?: Record<string, unknown>): void;
};

const noopLogger: MirrorLogger = {
  warn() {
    /* no-op */
  },
};

export type CaptureMirror = {
  readonly enabled: boolean;
  handleEvent(event: CaptureEvent): Promise<void>;
  handleBatch(events: readonly CaptureEvent[]): Promise<void>;
};

export type CreateCaptureMirrorOptions = {
  readonly client: MusubiClient;
  readonly config: MusubiConfig;
  readonly logger?: MirrorLogger;
  readonly now?: () => Date;
};

export function createCaptureMirror(options: CreateCaptureMirrorOptions): CaptureMirror {
  const { client, config } = options;
  const logger = options.logger ?? noopLogger;
  const now = options.now ?? (() => new Date());
  const enabled = config.capture?.mirrorOpenClawMemory !== false;

  return {
    enabled,

    async handleEvent(event: CaptureEvent): Promise<void> {
      if (!enabled) return;

      const payload = translateOrSkip(event, config, now, logger);
      if (payload === undefined) return;

      try {
        await client.post("/v1/episodic", {
          body: payload,
          idempotencyKey: deriveIdempotencyKey(event),
        });
      } catch (err) {
        logger.warn("musubi: mirror handleEvent failed; OpenClaw write unaffected", {
          source_ref: event.id,
          error: errorMessage(err),
        });
      }
    },

    async handleBatch(events: readonly CaptureEvent[]): Promise<void> {
      if (!enabled || events.length === 0) return;

      const payloads: EpisodicCapturePayload[] = [];
      const idempotencyKeys: string[] = [];
      for (const event of events) {
        const payload = translateOrSkip(event, config, now, logger);
        if (payload === undefined) continue;
        payloads.push(payload);
        idempotencyKeys.push(deriveIdempotencyKey(event));
      }
      if (payloads.length === 0) return;

      try {
        await client.post("/v1/episodic/batch", {
          body: { items: payloads, idempotency_keys: idempotencyKeys },
          // The batch endpoint gets its own top-level idempotency key composed
          // from the per-event keys so retried batches dedup as a unit.
          idempotencyKey: `batch:${idempotencyKeys.join(",")}`,
        });
      } catch (err) {
        logger.warn("musubi: mirror handleBatch failed; OpenClaw write unaffected", {
          batch_size: payloads.length,
          error: errorMessage(err),
        });
      }
    },
  };
}

function translateOrSkip(
  event: CaptureEvent,
  config: MusubiConfig,
  now: () => Date,
  logger: MirrorLogger,
): EpisodicCapturePayload | undefined {
  if (!event.content || event.content.length === 0) return undefined;

  let presence;
  try {
    presence = resolvePresence(config, { agentId: event.agentId });
  } catch (err) {
    logger.warn("musubi: mirror skipped event; presence resolution failed", {
      source_ref: event.id,
      error: errorMessage(err),
    });
    return undefined;
  }

  return translateCaptureEvent(event, presence, now);
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
