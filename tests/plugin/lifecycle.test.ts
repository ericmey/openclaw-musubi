import { describe, it, expect, vi } from "vitest";

import {
  createIntervalScheduler,
  createLifecycle,
  type Scheduler,
  type Stoppable,
} from "../../src/plugin/lifecycle.js";

describe("createLifecycle", () => {
  it("returns a handle whose initial state is not stopped", () => {
    const handle = createLifecycle({});
    expect(handle.isStopped()).toBe(false);
  });

  it("stops both the scheduler and the stream on stop()", async () => {
    const scheduler: Scheduler = { start: vi.fn(), stop: vi.fn() };
    const thoughtStream: Stoppable = { stop: vi.fn().mockResolvedValue(undefined) };
    const handle = createLifecycle({ scheduler, thoughtStream });

    await handle.stop();

    expect(scheduler.stop).toHaveBeenCalledOnce();
    expect(thoughtStream.stop).toHaveBeenCalledOnce();
    expect(handle.isStopped()).toBe(true);
  });

  it("stops the scheduler before awaiting the stream", async () => {
    const calls: string[] = [];
    const scheduler: Scheduler = {
      start: vi.fn(),
      stop: () => {
        calls.push("scheduler.stop");
      },
    };
    const thoughtStream: Stoppable = {
      stop: async () => {
        calls.push("stream.stop");
      },
    };
    const handle = createLifecycle({ scheduler, thoughtStream });

    await handle.stop();

    expect(calls).toEqual(["scheduler.stop", "stream.stop"]);
  });

  it("is idempotent — calling stop() twice does not double-stop", async () => {
    const scheduler: Scheduler = { start: vi.fn(), stop: vi.fn() };
    const thoughtStream: Stoppable = { stop: vi.fn().mockResolvedValue(undefined) };
    const handle = createLifecycle({ scheduler, thoughtStream });

    await handle.stop();
    await handle.stop();

    expect(scheduler.stop).toHaveBeenCalledOnce();
    expect(thoughtStream.stop).toHaveBeenCalledOnce();
  });

  it("tolerates an absent scheduler (supplement disabled)", async () => {
    const thoughtStream: Stoppable = { stop: vi.fn().mockResolvedValue(undefined) };
    const handle = createLifecycle({ thoughtStream });

    await expect(handle.stop()).resolves.toBeUndefined();
    expect(thoughtStream.stop).toHaveBeenCalledOnce();
  });

  it("tolerates an absent stream (thoughts disabled)", async () => {
    const scheduler: Scheduler = { start: vi.fn(), stop: vi.fn() };
    const handle = createLifecycle({ scheduler });

    await expect(handle.stop()).resolves.toBeUndefined();
    expect(scheduler.stop).toHaveBeenCalledOnce();
  });
});

describe("createIntervalScheduler", () => {
  it("runs the function on start and clears the interval on stop", async () => {
    vi.useFakeTimers();
    try {
      const fn = vi.fn(async () => {
        /* noop */
      });
      const sched = createIntervalScheduler({ fn, intervalMs: 1000 });
      sched.start();
      // The first tick is fire-and-forget (`void tick()`); drain the
      // microtask queue so the async fn's invocation is observable.
      await Promise.resolve();
      expect(fn).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1000);
      expect(fn).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1000);
      expect(fn).toHaveBeenCalledTimes(3);
      sched.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(fn).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes fn errors through onError without breaking the interval", async () => {
    vi.useFakeTimers();
    try {
      const errors: unknown[] = [];
      const fn = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValue(undefined);
      const sched = createIntervalScheduler({
        fn,
        intervalMs: 500,
        onError: (err) => errors.push(err),
      });
      sched.start();
      // Drain microtasks for the awaited rejection + interval setup.
      await vi.runOnlyPendingTimersAsync();
      expect(errors.length).toBe(1);
      expect((errors[0] as Error).message).toBe("boom");
      sched.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
