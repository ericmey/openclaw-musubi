import type { MusubiConfig } from "../config.js";
import type { MusubiClient } from "../musubi/client.js";
import { resolvePresence, type PresenceContext } from "../presence/resolver.js";
import {
  deriveIdempotencyKey,
  toCanonicalCapture,
  translateCaptureEvent,
  type CanonicalCaptureBody,
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

      const resolved = resolveOrSkip(event, config, now, logger);
      if (resolved === undefined) return;
      const { presence, payload } = resolved;

      try {
        await client.post("/v1/memories", {
          body: toCanonicalCapture(payload),
          idempotencyKey: deriveIdempotencyKey(event),
          token: presence.token,
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

      // One namespace per batch — the canonical `/v1/memories/batch`
      // endpoint takes a single top-level `namespace` and a list of
      // `items` rather than repeating the namespace per row. Group
      // events by their resolved namespace (and token) before dispatching.
      const byNamespace = new Map<
        string,
        { items: CanonicalCaptureBody[]; keys: string[]; token: string }
      >();
      for (const event of events) {
        const resolved = resolveOrSkip(event, config, now, logger);
        if (resolved === undefined) continue;
        const { presence, payload } = resolved;
        const canonical = toCanonicalCapture(payload);
        const bucket = byNamespace.get(canonical.namespace) ?? {
          items: [],
          keys: [],
          token: presence.token,
        };
        bucket.items.push(canonical);
        bucket.keys.push(deriveIdempotencyKey(event));
        byNamespace.set(canonical.namespace, bucket);
      }
      if (byNamespace.size === 0) return;

      for (const [namespace, bucket] of byNamespace) {
        const items = bucket.items.map((c) => ({
          content: c.content,
          importance: c.importance,
          tags: c.tags,
        }));
        try {
          await client.post("/v1/memories/batch", {
            body: { namespace, items },
            idempotencyKey: `batch:${bucket.keys.join(",")}`,
            token: bucket.token,
          });
        } catch (err) {
          logger.warn("musubi: mirror handleBatch failed; OpenClaw write unaffected", {
            namespace,
            batch_size: bucket.items.length,
            error: errorMessage(err),
          });
        }
      }
    },
  };
}

function resolveOrSkip(
  event: CaptureEvent,
  config: MusubiConfig,
  now: () => Date,
  logger: MirrorLogger,
):
  | {
      presence: PresenceContext;
      payload: EpisodicCapturePayload;
    }
  | undefined {
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

  const payload = translateCaptureEvent(event, presence, now);
  return { presence, payload };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
