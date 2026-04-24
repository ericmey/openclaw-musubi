/**
 * Translate an OpenClaw capture-eligible event into a Musubi episodic
 * capture payload. Pure function — no I/O. Easy to test in isolation.
 *
 * The `idempotencyKey` is derived from the source event id so a retried
 * mirror call posts to the same logical capture rather than creating
 * duplicates. See ADR-0001 for why dual-write is acceptable.
 */

import type { PresenceContext } from "../presence/resolver.js";

/**
 * Capture-eligible event from OpenClaw. Shape is intentionally narrow:
 * the wiring slice extracts these fields from whichever OpenClaw hook
 * fires (today: `agent_end`).
 */
export type CaptureEvent = {
  /** Stable id of the source memory; used to derive the idempotency key. */
  readonly id: string;
  /** Optional OpenClaw agent id; routed through presence resolution. */
  readonly agentId?: string;
  /** The capture-eligible text. */
  readonly content: string;
  /** ISO 8601 timestamp; defaults to now if absent. */
  readonly timestamp?: string;
  /** Importance hint, 1-10. Defaults to 5 (neutral). */
  readonly importance?: number;
  /** Optional topic tags. */
  readonly topics?: readonly string[];
  /** Free-form metadata; passed through to Musubi. */
  readonly metadata?: Readonly<Record<string, unknown>>;
};

/**
 * Plugin-internal capture shape. Rich by design — carries audit
 * metadata (`capture_source`, `source_ref`) plus free-form
 * `metadata` that the plugin and its users care about but that the
 * canonical Musubi API does not natively persist.
 *
 * At the HTTP boundary this is converted to `CanonicalCaptureBody`
 * via `toCanonicalCapture` below, which folds the audit fields into
 * `tags` (prefixed) so they round-trip through the episodic plane
 * without requiring a canonical API extension.
 */
export type EpisodicCapturePayload = {
  readonly namespace: string;
  readonly content: string;
  readonly capture_source: string;
  readonly source_ref: string;
  readonly timestamp: string;
  readonly importance: number;
  readonly topics: readonly string[];
  readonly metadata: Readonly<Record<string, unknown>>;
};

/**
 * Body shape accepted by `POST /v1/memories` on the canonical Musubi
 * API as of v0.4.0. Kept deliberately narrow — any field the
 * canonical `CaptureRequest` does not declare is silently dropped
 * server-side, which is why we prefer to fold our audit metadata
 * into `tags` rather than sending rich keys that never reach the
 * store.
 */
export type CanonicalCaptureBody = {
  readonly namespace: string;
  readonly content: string;
  readonly importance: number;
  readonly tags: readonly string[];
  readonly summary?: string;
};

export const TAG_SOURCE_PREFIX = "src:";
export const TAG_REF_PREFIX = "ref:";

/**
 * Convert the plugin-internal rich capture payload into the narrow
 * body shape the canonical Musubi API accepts. `capture_source` and
 * `source_ref` survive as prefixed tags (`src:openclaw-agent-end`,
 * `ref:<event-id>`) so downstream retrieval can still filter on
 * origin.
 *
 * `timestamp` is dropped: the Musubi server assigns `created_at`
 * at ingest time, and only operator-scoped callers may override it
 * (see Musubi #140). This plugin does not hold operator scope.
 *
 * `metadata` is dropped today because every call site sends `{}`.
 * If a real need emerges the canonical `CaptureRequest` will grow
 * a field upstream and this translator flips.
 */
export function toCanonicalCapture(
  payload: EpisodicCapturePayload,
): CanonicalCaptureBody {
  const tags = [
    ...payload.topics,
    `${TAG_SOURCE_PREFIX}${payload.capture_source}`,
    `${TAG_REF_PREFIX}${payload.source_ref}`,
  ];
  return {
    namespace: payload.namespace,
    content: payload.content,
    importance: payload.importance,
    tags,
  };
}

const CAPTURE_SOURCE = "openclaw-agent-end";
const DEFAULT_IMPORTANCE = 5;
const IDEMPOTENCY_PREFIX = "openclaw-mirror";

export function translateCaptureEvent(
  event: CaptureEvent,
  presence: PresenceContext,
  now: () => Date = () => new Date(),
): EpisodicCapturePayload {
  return {
    namespace: presence.namespaces.episodic,
    content: event.content,
    capture_source: CAPTURE_SOURCE,
    source_ref: event.id,
    timestamp: event.timestamp ?? now().toISOString(),
    importance: clampImportance(event.importance ?? DEFAULT_IMPORTANCE),
    topics: event.topics ?? [],
    metadata: event.metadata ?? {},
  };
}

export function deriveIdempotencyKey(event: CaptureEvent): string {
  return `${IDEMPOTENCY_PREFIX}:${event.id}`;
}

function clampImportance(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_IMPORTANCE;
  return Math.max(1, Math.min(10, Math.round(value)));
}
