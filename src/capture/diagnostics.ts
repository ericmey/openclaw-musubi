export type CaptureSkipReason =
  | "capture_disabled"
  | "event_not_object"
  | "messages_missing"
  | "assistant_missing"
  | "heartbeat_poll";

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
  "heartbeat_poll",
];

const PROCESS_CAPTURE_DIAGNOSTICS = Symbol.for("openclaw-musubi.capture-diagnostics.v1");

/**
 * Process-local, content-free instrumentation for the passive capture seam.
 * It deliberately records no agent ids, message text, hashes, or prompt data.
 */
export class CaptureDiagnostics {
  #sinceMs = Date.now();
  #observed = 0;
  #translated = 0;
  #enqueued = 0;
  #enqueueFailed = 0;
  #lastObservedAtMs: number | null = null;
  #lastEnqueuedAtMs: number | null = null;
  readonly #skipped = new Map<CaptureSkipReason, number>(SKIP_REASONS.map((reason) => [reason, 0]));

  reset(now = Date.now()): void {
    this.#sinceMs = now;
    this.#observed = 0;
    this.#translated = 0;
    this.#enqueued = 0;
    this.#enqueueFailed = 0;
    this.#lastObservedAtMs = null;
    this.#lastEnqueuedAtMs = null;
    for (const reason of SKIP_REASONS) this.#skipped.set(reason, 0);
  }

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

/**
 * OpenClaw can register the same plugin once per embedded run inside one
 * gateway process. Every registration must contribute to the same diagnostic
 * funnel or the service-owning instance will falsely report zero activity.
 */
export function getProcessCaptureDiagnostics(): CaptureDiagnostics {
  const root = globalThis as typeof globalThis & {
    [key: symbol]: CaptureDiagnostics | undefined;
  };
  let diagnostics = root[PROCESS_CAPTURE_DIAGNOSTICS];
  if (!diagnostics) {
    diagnostics = new CaptureDiagnostics();
    root[PROCESS_CAPTURE_DIAGNOSTICS] = diagnostics;
  }
  return diagnostics;
}
