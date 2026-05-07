/**
 * Entry-level idempotency tests.
 *
 * Confirms that the `register()` callback exported from `src/index.ts`:
 *  1. Invokes `bootstrap()` exactly once across multiple register calls
 *     when bootstrap succeeds.
 *  2. Allows retry on a subsequent register call when the previous
 *     bootstrap rejected.
 *
 * Why: openclaw can call `register()` repeatedly across plugin contexts
 * (snapshot vs activating loads, per-agent scopes). Pre-1.0.2 we ran the
 * full subsystem wiring on every call, blocking the gateway event loop
 * ~1s per re-bootstrap during real Discord turns. See `src/index.ts`
 * docstring + CHANGELOG 1.0.2.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the bootstrap module BEFORE importing src/index.ts so the entry
// picks up the mock at module-graph wire time.
const bootstrapMock = vi.fn();
vi.mock("../../src/plugin/bootstrap.js", () => ({
  bootstrap: bootstrapMock,
}));

// Dynamic re-import per test so the entry module's `bootstrapPromise`
// module-scope cache starts fresh. We deliberately avoid exporting a
// `__resetForTests()` seam from `src/index.ts` because it would leak a
// test-only function into the package's public API surface.
let entryModule: typeof import("../../src/index.js");

type LoggerCalls = {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
};

function makeMinimalApi(): { logger: LoggerCalls; pluginConfig: unknown } {
  return {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    pluginConfig: {},
  };
}

beforeEach(async () => {
  bootstrapMock.mockReset();
  vi.resetModules();
  entryModule = await import("../../src/index.js");
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("entry register() idempotency", () => {
  it("invokes bootstrap exactly once across multiple register calls", async () => {
    bootstrapMock.mockResolvedValue({ stop: () => {} });

    const entry = entryModule.default;
    const api = makeMinimalApi();

    // Simulate openclaw invoking register() three times across plugin contexts.
    entry.register(api as never);
    entry.register(api as never);
    entry.register(api as never);

    // Allow the fire-and-forget promise to settle.
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(bootstrapMock).toHaveBeenCalledTimes(1);
    expect(api.logger.error).not.toHaveBeenCalled();
  });

  it("allows retry on next register() call after a failed bootstrap", async () => {
    const error = new Error("simulated bootstrap failure");
    bootstrapMock.mockRejectedValueOnce(error);
    bootstrapMock.mockResolvedValueOnce({ stop: () => {} });

    const entry = entryModule.default;
    const api = makeMinimalApi();

    // First call: bootstrap rejects, error is logged, promise cache is cleared.
    entry.register(api as never);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(bootstrapMock).toHaveBeenCalledTimes(1);
    expect(api.logger.error).toHaveBeenCalledOnce();

    // Second call: bootstrap should be retried (cache was cleared on rejection).
    entry.register(api as never);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(bootstrapMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry after a successful bootstrap (cache persists)", async () => {
    bootstrapMock.mockResolvedValue({ stop: () => {} });

    const entry = entryModule.default;
    const api = makeMinimalApi();

    entry.register(api as never);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(bootstrapMock).toHaveBeenCalledTimes(1);

    // Even after the in-flight bootstrap settles, subsequent register
    // calls remain no-ops — the success cache is permanent for the
    // process lifetime.
    entry.register(api as never);
    entry.register(api as never);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(bootstrapMock).toHaveBeenCalledTimes(1);
  });
});
