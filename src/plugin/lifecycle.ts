/**
 * Plugin lifecycle coordinator.
 *
 * The wiring slice (#15) composes a pair of long-lived subsystems — the
 * prompt-supplement refresh scheduler (polls Musubi for standing context
 * on an interval so `PromptSupplement.build` stays synchronous) and the
 * SSE thought-stream consumer (long-poll reconnect loop). Both need a
 * single shared stop() entry point so OpenClaw's plugin unload tears
 * them down deterministically.
 *
 * Keeping this out of `bootstrap.ts` means tests can exercise stop
 * ordering without re-mocking every subsystem.
 */

export type Stoppable = {
  stop(): Promise<void> | void;
};

export type Scheduler = {
  start(): void;
  stop(): void;
};

export type LifecycleHandle = {
  /** Idempotent — calling stop() twice is a no-op. */
  stop(): Promise<void>;
  /** Observable for tests + status checks. */
  isStopped(): boolean;
};

export type CreateLifecycleOptions = {
  /** Refresh scheduler for the prompt supplement. Optional — absent
   * when `supplement.enabled === false`. */
  readonly scheduler?: Scheduler;
  /** SSE thought stream. Optional — absent when `thoughts.enabled === false`. */
  readonly thoughtStream?: Stoppable;
};

export function createLifecycle(options: CreateLifecycleOptions): LifecycleHandle {
  let stopped = false;

  return {
    isStopped: () => stopped,
    async stop() {
      if (stopped) return;
      stopped = true;

      // Stop the scheduler first (synchronous, cheap) so an in-flight
      // refresh can't race against the client teardown.
      options.scheduler?.stop();

      // Stream stop aborts the current fetch + prevents reconnect. It's
      // async because AbortController + in-flight body drain settle on
      // the microtask queue.
      if (options.thoughtStream) {
        await options.thoughtStream.stop();
      }
    },
  };
}

/**
 * Build an interval-backed scheduler that invokes `fn` every
 * `intervalMs` after an immediate first call. Errors from `fn` are
 * swallowed + reported via `onError` (if provided) so the interval
 * keeps ticking — consistent with the "failures must never block
 * OpenClaw" principle that `capture/mirror.ts` codifies for the
 * capture path.
 */
export function createIntervalScheduler(options: {
  readonly fn: () => Promise<void>;
  readonly intervalMs: number;
  readonly onError?: (err: unknown) => void;
}): Scheduler {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;

  const tick = async (): Promise<void> => {
    if (running) return; // re-entrance guard — interval races on slow refresh
    running = true;
    try {
      await options.fn();
    } catch (err) {
      options.onError?.(err);
    } finally {
      running = false;
    }
  };

  return {
    start() {
      if (timer !== undefined) return;
      // Fire one immediate tick so the supplement cache is warm before
      // OpenClaw's first prompt assembly, then fall into the interval.
      void tick();
      timer = setInterval(() => void tick(), options.intervalMs);
    },
    stop() {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
