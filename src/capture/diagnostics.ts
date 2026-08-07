export type CaptureSkipReason =
  | "capture_disabled"
  | "event_not_object"
  | "messages_missing"
  | "assistant_missing";

export type CaptureDiagnosticsSnapshot = {
  readonly sinceMs: number;
  readonly observed: number;
  readonly translated: number;
  readonly enqueued: number;
  readonly enqueueFailed: number;
  readonly skipped: Readonly<Record<CaptureSkipReason, number>>;
  readonly lastObservedAtMs: number | null;
  readonly lastEnqueuedAtMs: number | null;
};

const SKIP_REASONS: readonly CaptureSkipReason[] = [
  "capture_disabled",
  "event_not_object",
  "messages_missing",
  "assistant_missing",
];

/**
 * Process-local, content-free instrumentation for the passive capture seam.
 * It deliberately records no agent ids, message text, hashes, or prompt data.
 */
export class CaptureDiagnostics {
  readonly #sinceMs = Date.now();
  #observed = 0;
  #translated = 0;
  #enqueued = 0;
  #enqueueFailed = 0;
  #lastObservedAtMs: number | null = null;
  #lastEnqueuedAtMs: number | null = null;
  readonly #skipped = new Map<CaptureSkipReason, number>(SKIP_REASONS.map((reason) => [reason, 0]));

  observe(now = Date.now()): void {
    this.#observed += 1;
    this.#lastObservedAtMs = now;
  }

  translated(): void {
    this.#translated += 1;
  }

  enqueued(now = Date.now()): void {
    this.#enqueued += 1;
    this.#lastEnqueuedAtMs = now;
  }

  enqueueFailed(): void {
    this.#enqueueFailed += 1;
  }

  skip(reason: CaptureSkipReason): void {
    this.#skipped.set(reason, (this.#skipped.get(reason) ?? 0) + 1);
  }

  snapshot(): CaptureDiagnosticsSnapshot {
    return {
      sinceMs: this.#sinceMs,
      observed: this.#observed,
      translated: this.#translated,
      enqueued: this.#enqueued,
      enqueueFailed: this.#enqueueFailed,
      skipped: Object.fromEntries(
        SKIP_REASONS.map((reason) => [reason, this.#skipped.get(reason) ?? 0]),
      ) as Record<CaptureSkipReason, number>,
      lastObservedAtMs: this.#lastObservedAtMs,
      lastEnqueuedAtMs: this.#lastEnqueuedAtMs,
    };
  }
}
