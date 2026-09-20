import { describe, expect, it } from "vitest";
import { MusubiClient } from "../../src/musubi/client.js";
import {
  AuthError,
  ClientError,
  NotFoundError,
  RateLimitError,
  ServerError,
} from "../../src/musubi/errors.js";
import type { FetchLike } from "../../src/musubi/types.js";

type RecordedCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
};

type ScriptedResponse =
  | {
      status: number;
      body?: unknown;
      headers?: Record<string, string>;
    }
  | { throw: Error };

function createMockFetch(script: ScriptedResponse[]): {
  fetch: FetchLike;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let cursor = 0;

  const fetch: FetchLike = async (url, init) => {
    const headers: Record<string, string> = {};
    const headerInit = init.headers;
    if (headerInit) {
      if (Array.isArray(headerInit)) {
        for (const [k, v] of headerInit) {
          if (k !== undefined && v !== undefined) headers[k] = v;
        }
      } else if (headerInit instanceof Headers) {
        headerInit.forEach((value, key) => {
          headers[key] = value;
        });
      } else {
        for (const [k, v] of Object.entries(headerInit as Record<string, string>)) {
          headers[k] = v;
        }
      }
    }

    calls.push({
      url,
      method: init.method ?? "GET",
      headers,
      body: typeof init.body === "string" ? init.body : undefined,
    });

    const def = script[cursor] ?? script[script.length - 1];
    cursor += 1;
    if (def === undefined) {
      throw new Error("mock fetch script exhausted");
    }
    if ("throw" in def) {
      throw def.throw;
    }

    return new Response(def.body !== undefined ? JSON.stringify(def.body) : null, {
      status: def.status,
      headers: { "content-type": "application/json", ...(def.headers ?? {}) },
    });
  };

  return { fetch, calls };
}

function makeClient(
  fetch: FetchLike,
  overrides: Partial<ConstructorParameters<typeof MusubiClient>[0]> = {},
) {
  return new MusubiClient({
    baseUrl: "https://musubi.test",
    token: "test-token",
    fetch,
    sleep: async () => undefined, // skip real waits in tests
    random: () => 0, // deterministic jitter
    generateRequestId: () => "req-fixed-id",
    generateIdempotencyKey: () => "idem-fixed-key",
    ...overrides,
  });
}

describe("MusubiClient", () => {
  it("test_client_sends_bearer_and_request_id_on_every_call", async () => {
    const { fetch, calls } = createMockFetch([
      { status: 200, body: { ok: true } },
      { status: 200, body: { ok: true } },
    ]);
    const client = makeClient(fetch);

    await client.get("/v1/ops/health");
    await client.get("/v1/namespaces");

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.headers["Authorization"]).toBe("Bearer test-token");
      expect(call.headers["X-Request-Id"]).toBe("req-fixed-id");
    }
  });

  it("test_client_adds_idempotency_key_on_post_writes", async () => {
    const { fetch, calls } = createMockFetch([
      { status: 200, body: { ok: true } }, // POST
      { status: 200, body: { ok: true } }, // GET
      { status: 200, body: { ok: true } }, // PATCH
    ]);
    const client = makeClient(fetch);

    await client.post("/v1/episodic", { body: { content: "x" } });
    await client.get("/v1/episodic/abc");
    await client.patch("/v1/episodic/abc", { body: { content: "y" } });

    expect(calls[0]?.headers["Idempotency-Key"]).toBe("idem-fixed-key");
    expect(calls[1]?.headers["Idempotency-Key"]).toBeUndefined();
    expect(calls[2]?.headers["Idempotency-Key"]).toBeUndefined();
  });

  it("test_client_reuses_idempotency_key_on_retry", async () => {
    const { fetch, calls } = createMockFetch([
      { status: 503 }, // first attempt: server error
      { status: 503 }, // second attempt: server error
      { status: 200, body: { ok: true } }, // third: success
    ]);
    const client = makeClient(fetch);

    await client.post("/v1/episodic", { body: { content: "x" } });

    expect(calls).toHaveLength(3);
    const keys = calls.map((c) => c.headers["Idempotency-Key"]);
    expect(keys[0]).toBe("idem-fixed-key");
    expect(keys[1]).toBe("idem-fixed-key");
    expect(keys[2]).toBe("idem-fixed-key");
  });

  it("test_client_retries_on_network_error_with_exponential_backoff", async () => {
    const sleepCalls: number[] = [];
    const { fetch, calls } = createMockFetch([
      { throw: new TypeError("fetch failed") },
      { throw: new TypeError("fetch failed") },
      { status: 200, body: { ok: true } },
    ]);
    const client = makeClient(fetch, {
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });

    const result = await client.get<{ ok: boolean }>("/v1/ops/health");

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(3);
    // No-jitter random=0 so delays are pure exponential: 500, 1000.
    expect(sleepCalls).toEqual([500, 1_000]);
  });

  it("test_client_retries_on_5xx_bounded_attempts", async () => {
    const sleepCalls: number[] = [];
    // Always returns 500 — should attempt maxAttempts times then give up.
    const { fetch, calls } = createMockFetch([{ status: 500, body: { error: "boom" } }]);
    const client = makeClient(fetch, {
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
      retry: { maxAttempts: 3 },
    });

    await expect(client.get("/v1/ops/health")).rejects.toBeInstanceOf(ServerError);

    expect(calls).toHaveLength(3);
    expect(sleepCalls).toHaveLength(2); // sleeps between attempts only
  });

  it("test_client_honors_retry_after_on_429", async () => {
    const sleepCalls: number[] = [];
    const { fetch, calls } = createMockFetch([
      { status: 429, headers: { "Retry-After": "2" } },
      { status: 200, body: { ok: true } },
    ]);
    const client = makeClient(fetch, {
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });

    await client.get("/v1/retrieve");

    expect(calls).toHaveLength(2);
    expect(sleepCalls).toEqual([2_000]); // 2 seconds → 2000 ms, not exponential default
  });

  it("test_client_does_not_retry_on_4xx_except_429", async () => {
    const sleepCalls: number[] = [];
    const { fetch, calls } = createMockFetch([{ status: 400, body: { error: "bad" } }]);
    const client = makeClient(fetch, {
      sleep: async (ms) => {
        sleepCalls.push(ms);
      },
    });

    await expect(client.get("/v1/retrieve")).rejects.toBeInstanceOf(ClientError);

    expect(calls).toHaveLength(1);
    expect(sleepCalls).toEqual([]);
  });

  it("test_client_maps_401_403_to_auth_error", async () => {
    const { fetch: fetch401 } = createMockFetch([{ status: 401 }]);
    const { fetch: fetch403 } = createMockFetch([{ status: 403 }]);
    const client401 = makeClient(fetch401);
    const client403 = makeClient(fetch403);

    let err401: unknown;
    let err403: unknown;
    try {
      await client401.get("/v1/curated");
    } catch (e) {
      err401 = e;
    }
    try {
      await client403.get("/v1/curated");
    } catch (e) {
      err403 = e;
    }

    expect(err401).toBeInstanceOf(AuthError);
    expect(err403).toBeInstanceOf(AuthError);
    expect((err401 as AuthError).status).toBe(401);
    expect((err403 as AuthError).status).toBe(403);
  });

  it("test_client_maps_404_to_not_found_error", async () => {
    const { fetch } = createMockFetch([{ status: 404 }]);
    const client = makeClient(fetch);

    let err: unknown;
    try {
      await client.get("/v1/curated/missing-id");
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(NotFoundError);
    expect((err as NotFoundError).status).toBe(404);
    expect((err as NotFoundError).message).toContain("/v1/curated/missing-id");
  });

  it("test_client_honors_per_request_timeout_from_config", async () => {
    // Stub fetch that never resolves until aborted.
    const seenSignals: AbortSignal[] = [];
    const fetch: FetchLike = (_input, init) => {
      const signal = init.signal as AbortSignal;
      seenSignals.push(signal);
      return new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          },
          { once: true },
        );
      });
    };
    const client = makeClient(fetch, {
      requestTimeoutMs: 5,
      retry: { maxAttempts: 1 }, // fail fast for the test
    });

    // The deadline surfaces as `timeout`, not `network`: the subclass used to
    // be constructed and then immediately discarded, so `code: "timeout"` was
    // unreachable and callers could not tell a deadline from a dropped socket.
    await expect(client.get("/v1/ops/health")).rejects.toMatchObject({
      code: "timeout",
    });

    expect(seenSignals[0]?.aborted).toBe(true);
  });

  it("rate-limit error retains retry-after-ms", async () => {
    const { fetch } = createMockFetch([{ status: 429, headers: { "Retry-After": "3" } }]);
    const client = makeClient(fetch, { retry: { maxAttempts: 1 } });

    let err: unknown;
    try {
      await client.get("/v1/retrieve");
    } catch (e) {
      err = e;
    }

    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfterMs).toBe(3_000);
  });

  it("strips trailing slash from baseUrl and serializes query params", async () => {
    const { fetch, calls } = createMockFetch([{ status: 200, body: {} }]);
    const client = new MusubiClient({
      baseUrl: "https://musubi.test/", // trailing slash
      token: "t",
      fetch,
    });

    await client.get("/v1/episodic", { query: { limit: 10, includeUnread: true } });

    expect(calls[0]?.url).toBe("https://musubi.test/v1/episodic?limit=10&includeUnread=true");
  });

  it("honors per-request token override", async () => {
    const { fetch, calls } = createMockFetch([
      { status: 200, body: { ok: true } },
      { status: 200, body: { ok: true } },
    ]);
    const client = makeClient(fetch);

    await client.get("/v1/namespaces");
    await client.get("/v1/namespaces", { token: "per-request-token" });

    expect(calls[0]?.headers["Authorization"]).toBe("Bearer test-token");
    expect(calls[1]?.headers["Authorization"]).toBe("Bearer per-request-token");
  });

  it("rejects non-http baseUrl at construction", () => {
    expect(() => new MusubiClient({ baseUrl: "javascript:alert(1)", token: "t" })).toThrow(
      /must be http\(s\)/,
    );
    expect(() => new MusubiClient({ baseUrl: "file:///etc/passwd", token: "t" })).toThrow(
      /must be http\(s\)/,
    );
  });

  it("cleans up external abort listener after success", async () => {
    const ac = new AbortController();
    const { fetch } = createMockFetch([{ status: 200, body: {} }]);
    const client = makeClient(fetch);

    await client.get("/v1/ops/health", { signal: ac.signal });

    // No way to count listeners portably, but the code path is exercised.
    // If the listener leaked, subsequent aborts would error the already-
    // settled promise — which doesn't happen here because the fetch resolved.
    expect(ac.signal.aborted).toBe(false);
  });
});

function client_forListenerTest(fetch: FetchLike) {
  return makeClient(fetch, { sleep: async () => undefined });
}

describe("MusubiClient retry boundaries", () => {
  it("does not retry a request the caller aborted", async () => {
    let calls = 0;
    const slept: number[] = [];
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        calls += 1;
        const signal = init.signal as AbortSignal;
        const fail = () => reject(new DOMException("aborted", "AbortError"));
        if (signal.aborted) fail();
        else signal.addEventListener("abort", fail, { once: true });
      });
    const client = makeClient(fetch, { sleep: async (ms) => void slept.push(ms) });

    const controller = new AbortController();
    const pending = client.get("/v1/ops/health", { signal: controller.signal });
    controller.abort();

    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    // Previously the abort was classified `network` and retried: the caller's
    // cancellation cost a full 5-attempt budget plus ~7.5s of backoff sleeps,
    // and during shutdown kept writing long after stop() had returned.
    expect(calls).toBe(1);
    expect(slept).toEqual([]);
  });

  it("still retries a per-request deadline", async () => {
    let calls = 0;
    const fetch: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        calls += 1;
        (init.signal as AbortSignal).addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    const client = makeClient(fetch, { requestTimeoutMs: 1, retry: { maxAttempts: 3 } });

    await expect(client.get("/v1/ops/health")).rejects.toMatchObject({ code: "timeout" });
    expect(calls).toBe(3);
  });

  it("sleeps a short Retry-After in band", async () => {
    const slept: number[] = [];
    const { fetch } = createMockFetch([
      { status: 429, headers: { "Retry-After": "2" } },
      { status: 200, body: { ok: true } },
    ]);
    const client = makeClient(fetch, { sleep: async (ms) => void slept.push(ms) });

    await expect(client.get("/v1/ops/health")).resolves.toEqual({ ok: true });
    expect(slept).toEqual([2_000]);
  });

  it("honors the longest Retry-After Musubi can actually emit", async () => {
    const slept: number[] = [];
    const { fetch } = createMockFetch([
      // Musubi's rate limiter uses a fixed 60s window and returns
      // `max(1, 60 - elapsed)`, so 60s is the ceiling of the real contract.
      // Refusing it would turn a legitimate backoff into a tool error.
      { status: 429, headers: { "Retry-After": "60" } },
      { status: 200, body: { ok: true } },
    ]);
    const client = makeClient(fetch, { sleep: async (ms) => void slept.push(ms) });

    await expect(client.get("/v1/ops/health")).resolves.toEqual({ ok: true });
    expect(slept).toEqual([60_000]);
  });

  it("surfaces a Retry-After longer than maxRetryAfterMs instead of sleeping on it", async () => {
    const slept: number[] = [];
    const { fetch, calls } = createMockFetch([
      { status: 429, headers: { "Retry-After": "86400" } },
      { status: 200, body: { ok: true } },
    ]);
    const client = makeClient(fetch, { sleep: async (ms) => void slept.push(ms) });

    // An in-band sleep here holds the delivery worker's drain lock, so a
    // 24h Retry-After used to freeze every other queued row. The wait now
    // belongs to the durable outbox, which schedules it without blocking.
    const error = await client.get("/v1/ops/health").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryAfterMs).toBe(86_400_000);
    expect(slept).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("keeps the Retry-After bound when a caller passes an explicit undefined", async () => {
    const slept: number[] = [];
    const { fetch } = createMockFetch([{ status: 429, headers: { "Retry-After": "86400" } }]);
    const client = makeClient(fetch, {
      sleep: async (ms) => void slept.push(ms),
      retry: { maxAttempts: 5, maxRetryAfterMs: undefined as unknown as number },
    });

    await expect(client.get("/v1/ops/health")).rejects.toBeInstanceOf(RateLimitError);
    expect(slept).toEqual([]);
  });

  it("aborts out of a backoff wait instead of sleeping through a shutdown", async () => {
    let calls = 0;
    const { fetch } = createMockFetch([
      { status: 503, body: "down" },
      { status: 200, body: { ok: true } },
    ]);
    const counting: FetchLike = (url, init) => {
      calls += 1;
      return fetch(url, init);
    };
    const controller = new AbortController();
    // A real 60s wait, abandoned mid-flight.
    const client = makeClient(counting, {
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    });

    const pending = client.get("/v1/ops/health", { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();

    // Sleeping through the abort let the loop wake after stop() had returned
    // and the controller had closed the outbox — so the worker's AbortedError
    // path wrote to a closed database.
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    expect(calls).toBe(1);
  });

  it("does not accumulate an abort listener per retry", async () => {
    const { fetch } = createMockFetch([
      { status: 503, body: "down" },
      { status: 503, body: "down" },
      { status: 200, body: { ok: true } },
    ]);
    const controller = new AbortController();
    let peak = 0;
    let live = 0;
    const signal = controller.signal;
    const realAdd = signal.addEventListener.bind(signal);
    const realRemove = signal.removeEventListener.bind(signal);
    signal.addEventListener = ((...args: Parameters<typeof realAdd>) => {
      live += 1;
      peak = Math.max(peak, live);
      return realAdd(...args);
    }) as typeof realAdd;
    signal.removeEventListener = ((...args: Parameters<typeof realRemove>) => {
      live -= 1;
      return realRemove(...args);
    }) as typeof realRemove;

    await expect(client_forListenerTest(fetch).get("/v1/x", { signal })).resolves.toEqual({
      ok: true,
    });
    expect(live).toBe(0);
    expect(peak).toBeLessThanOrEqual(2);
  });

  it("ignores a blank Retry-After rather than retrying immediately", async () => {
    const slept: number[] = [];
    const { fetch } = createMockFetch([
      { status: 429, headers: { "Retry-After": "  " } },
      { status: 200, body: { ok: true } },
    ]);
    const client = makeClient(fetch, { sleep: async (ms) => void slept.push(ms) });

    await expect(client.get("/v1/ops/health")).resolves.toEqual({ ok: true });
    // `Number("")` is 0, which would have scheduled a hot retry.
    expect(slept).toEqual([500]);
  });
});
