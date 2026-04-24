import type { MusubiConfig } from "../config.js";
import { resolvePresence } from "../presence/resolver.js";
import { nextSseBackoffMs } from "./backoff.js";
import { BoundedDedupSet } from "./dedup.js";
import { InMemoryLastEventIdStore, type LastEventIdStore } from "./persistence.js";

/**
 * SSE consumer for Musubi's `GET /v1/thoughts/stream` endpoint.
 *
 * Implements all six consumer-expectation rules from
 * `docs/api-contract.md` §SSE — backoff with jitter, persisted
 * Last-Event-ID resume, bounded dedup, 403 no-reconnect, ping-gap
 * timeout, lex (string) `object_id` comparison.
 *
 * Public surface: `createThoughtStream(opts).start(handlers)` and
 * `.stop()`. `start` enters a reconnect loop; `stop` aborts the current
 * connection and prevents further reconnects.
 */

export type ThoughtPayload = {
  readonly object_id: string;
  readonly from_presence: string;
  readonly to_presence: string;
  readonly namespace: string;
  readonly content: string;
  readonly channel?: string;
  readonly importance?: number;
  readonly sent_at: string;
};

export type ThoughtStreamHandlers = {
  onThought: (thought: ThoughtPayload) => void | Promise<void>;
  onConnected?: () => void;
  onDisconnect?: (reason: string) => void;
  onAuthError?: (status: 401 | 403) => void;
};

export type FetchForStream = (input: string, init: RequestInit) => Promise<Response>;

export type CreateThoughtStreamOptions = {
  readonly config: MusubiConfig;
  readonly agentId?: string;
  readonly fetch?: FetchForStream;
  readonly dedup?: BoundedDedupSet;
  readonly persistence?: LastEventIdStore;
  readonly random?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  /** Default 60s — 2× the spec's 30s ping interval. */
  readonly pingTimeoutMs?: number;
  /** Reset backoff attempt counter after this much stable connection. */
  readonly stableResetMs?: number;
  /** Override `include` query param. Default omitted (server applies default). */
  readonly include?: string;
  /** Upper bound on reconnect backoff. Defaults to 60s. */
  readonly maxBackoffMs?: number;
};

export type ThoughtStream = {
  start(handlers: ThoughtStreamHandlers): Promise<void>;
  stop(): Promise<void>;
  isRunning(): boolean;
  /** Test-only inspection. */
  __backoffAttempt(): number;
};

const DEFAULT_PING_TIMEOUT_MS = 60_000;
const DEFAULT_STABLE_RESET_MS = 5 * 60_000;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function createThoughtStream(options: CreateThoughtStreamOptions): ThoughtStream {
  const { config } = options;
  const fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const dedup = options.dedup ?? new BoundedDedupSet();
  const persistence = options.persistence ?? new InMemoryLastEventIdStore();
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const pingTimeoutMs = options.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS;
  const stableResetMs = options.stableResetMs ?? DEFAULT_STABLE_RESET_MS;
  const maxBackoffMs = options.maxBackoffMs;
  const baseUrl = config.core.baseUrl.replace(/\/+$/, "");

  let running = false;
  let abortController: AbortController | undefined;
  let attempt = 0;

  const stream: ThoughtStream = {
    isRunning: () => running,
    __backoffAttempt: () => attempt,

    async stop() {
      running = false;
      abortController?.abort();
    },

    async start(handlers) {
      if (running) return;
      running = true;
      attempt = 0;

      let presence;
      try {
        presence = resolvePresence(config, { agentId: options.agentId });
      } catch {
        running = false;
        return;
      }

      const url = buildStreamUrl(baseUrl, presence.presence, options.include);

      while (running) {
        const connectedAtCandidate = now();
        const outcome = await runOneConnection({
          url,
          token: presence.token,
          fetch,
          dedup,
          persistence,
          pingTimeoutMs,
          handlers,
          getRunning: () => running,
          setAbortController: (c) => {
            abortController = c;
          },
        });

        if (outcome.kind === "auth-fail") {
          handlers.onAuthError?.(outcome.status);
          handlers.onDisconnect?.(`auth-${outcome.status}`);
          running = false;
          return;
        }

        if (!running) {
          handlers.onDisconnect?.("stopped");
          return;
        }

        handlers.onDisconnect?.(outcome.kind);

        const stableDuration = now() - connectedAtCandidate;
        if (outcome.connected && stableDuration >= stableResetMs) {
          attempt = 0;
        }

        let delayMs: number;
        if (outcome.kind === "close" && outcome.reconnectAfterMs !== undefined) {
          delayMs = outcome.reconnectAfterMs;
        } else if (outcome.kind === "http-error" && outcome.retryAfterMs !== undefined) {
          delayMs = outcome.retryAfterMs;
        } else {
          delayMs = nextSseBackoffMs(attempt, { random, maxDelayMs: maxBackoffMs });
        }
        attempt += 1;

        await sleep(delayMs);
      }
    },
  };

  return stream;
}

function buildStreamUrl(baseUrl: string, presence: string, include?: string): string {
  const params = new URLSearchParams({ namespace: presence });
  if (include !== undefined) params.set("include", include);
  return `${baseUrl}/v1/thoughts/stream?${params.toString()}`;
}

type ConnectionOutcome =
  | { kind: "auth-fail"; status: 401 | 403; connected: false }
  | { kind: "http-error"; status: number; connected: false; retryAfterMs?: number }
  | { kind: "network-error"; connected: false }
  | { kind: "stream-error"; connected: true }
  | { kind: "ping-gap-timeout"; connected: true }
  | { kind: "ended"; connected: true }
  | { kind: "close"; connected: true; reconnectAfterMs: number | undefined };

type ConnectionContext = {
  url: string;
  token: string;
  fetch: FetchForStream;
  dedup: BoundedDedupSet;
  persistence: LastEventIdStore;
  pingTimeoutMs: number;
  handlers: ThoughtStreamHandlers;
  getRunning: () => boolean;
  setAbortController: (controller: AbortController) => void;
};

async function runOneConnection(ctx: ConnectionContext): Promise<ConnectionOutcome> {
  const controller = new AbortController();
  ctx.setAbortController(controller);

  let pingTimer: ReturnType<typeof setTimeout> | undefined;
  let pingGapTriggered = false;
  const resetPingTimer = () => {
    if (pingTimer) clearTimeout(pingTimer);
    pingTimer = setTimeout(() => {
      pingGapTriggered = true;
      controller.abort();
    }, ctx.pingTimeoutMs);
  };

  const lastSeenId = await ctx.persistence.read();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${ctx.token}`,
    Accept: "text/event-stream",
    "Cache-Control": "no-cache",
  };
  if (lastSeenId !== undefined) {
    headers["Last-Event-ID"] = lastSeenId;
  }

  let response: Response;
  try {
    response = await ctx.fetch(ctx.url, {
      method: "GET",
      headers,
      signal: controller.signal,
    });
  } catch {
    if (pingTimer) clearTimeout(pingTimer);
    return { kind: "network-error", connected: false };
  }

  if (response.status === 401 || response.status === 403) {
    if (pingTimer) clearTimeout(pingTimer);
    return { kind: "auth-fail", status: response.status as 401 | 403, connected: false };
  }
  if (!response.ok || !response.body) {
    if (pingTimer) clearTimeout(pingTimer);
    const retryAfterMs =
      response.status === 503
        ? parseRetryAfter(response.headers.get("Retry-After"))
        : undefined;
    return { kind: "http-error", status: response.status, connected: false, retryAfterMs };
  }

  resetPingTimer();
  ctx.handlers.onConnected?.();

  try {
    for await (const frame of parseSseStream(response.body)) {
      resetPingTimer();
      if (!ctx.getRunning()) {
        return { kind: "ended", connected: true };
      }

      if (frame.event === "thought") {
        const thought = safeJsonParse<ThoughtPayload>(frame.data);
        if (thought === undefined) continue;
        const id = frame.id ?? thought.object_id;
        if (ctx.dedup.add(id)) {
          await ctx.handlers.onThought(thought);
          await ctx.persistence.write(id);
        }
      } else if (frame.event === "close") {
        const data = safeJsonParse<{ reconnect_after_ms?: number }>(frame.data);
        return {
          kind: "close",
          connected: true,
          reconnectAfterMs: data?.reconnect_after_ms,
        };
      }
      // Pings just reset the timer (already done above).
    }
    return { kind: "ended", connected: true };
  } catch {
    if (pingGapTriggered) {
      return { kind: "ping-gap-timeout", connected: true };
    }
    return { kind: "stream-error", connected: true };
  } finally {
    if (pingTimer) clearTimeout(pingTimer);
  }
}

type SseFrame = { readonly event: string; readonly id: string | undefined; readonly data: string };

async function* parseSseStream(body: ReadableStream<Uint8Array>): AsyncGenerator<SseFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "";
  let id: string | undefined;
  let dataLines: string[] = [];

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        if (buffer.length > 0) {
          buffer += "\n\n";
        }
      }
      if (value !== undefined) {
        buffer += decoder.decode(value, { stream: !done });
      }

      const lines = buffer.split(/\r\n?|\n/);
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (line === "") {
          if (dataLines.length > 0 || event !== "") {
            yield { event: event || "message", id, data: dataLines.join("\n") };
          }
          event = "";
          id = undefined;
          dataLines = [];
          continue;
        }
        if (line.startsWith(":")) {
          continue; // SSE comment
        }
        if (line.startsWith("event:")) {
          event = line.slice(6).replace(/^ /, "");
        } else if (line.startsWith("id:")) {
          id = line.slice(3).replace(/^ /, "");
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).replace(/^ /, ""));
        }
        // Other field names (retry:) are accepted by spec but unused here.
      }

      if (done) break;
    }
  } finally {
    reader.releaseLock();
  }
}

function safeJsonParse<T>(raw: string): T | undefined {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function parseRetryAfter(header: string | null): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const dateMs = Date.parse(header);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return undefined;
}
