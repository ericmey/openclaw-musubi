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
  /** Importance hint, 0-10. Defaults to 5 (neutral). */
  readonly importance?: number;
  /** Optional topic tags. */
  readonly topics?: readonly string[];
  /** Free-form metadata; passed through to Musubi. */
  readonly metadata?: Readonly<Record<string, unknown>>;
};

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
  return Math.max(0, Math.min(10, Math.round(value)));
}
