import type { MusubiConfig } from "../config.js";
import type { MusubiClient } from "../musubi/client.js";
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
  /** Musubi client for history backfill when replay is truncated. */
  readonly client?: MusubiClient;
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

      const client = options.client;

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
          now,
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

        // History backfill when the server signals replay truncation.
        // We backfill *before* reconnecting so the next Last-Event-ID
        // covers the gap.
        if (outcome.connected && outcome.truncated && client !== undefined) {
          try {
            await backfillHistory({
              client,
              namespace: presence.namespaces.thought,
              presence: presence.presence,
              token: presence.token,
              dedup,
              handlers,
              persistence,
              getRunning: () => running,
            });
          } catch {
            // Backfill is best-effort; ignore errors and reconnect normally.
          }
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
  | { kind: "stream-error"; connected: true; truncated?: boolean }
  | { kind: "ping-gap-timeout"; connected: true; truncated?: boolean }
  | { kind: "ended"; connected: true; truncated?: boolean }
  | { kind: "close"; connected: true; reconnectAfterMs: number | undefined; truncated?: boolean };

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
  now: () => number;
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
        ? parseRetryAfter(response.headers.get("Retry-After"), ctx.now)
        : undefined;
    return { kind: "http-error", status: response.status, connected: false, retryAfterMs };
  }

  const truncated = response.headers.get("X-Musubi-Replay-Truncated") === "true";

  resetPingTimer();
  ctx.handlers.onConnected?.();

  try {
    for await (const frame of parseSseStream(response.body)) {
      resetPingTimer();
      if (!ctx.getRunning()) {
        return { kind: "ended", connected: true, truncated };
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
          truncated,
        };
      }
      // Pings just reset the timer (already done above).
    }
    return { kind: "ended", connected: true, truncated };
  } catch {
    if (pingGapTriggered) {
      return { kind: "ping-gap-timeout", connected: true, truncated };
    }
    return { kind: "stream-error", connected: true, truncated };
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

function parseRetryAfter(header: string | null, now: () => number = Date.now): number | undefined {
  if (header === null) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const dateMs = Date.parse(header);
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - now());
  }
  return undefined;
}

// ------------------------------------------------------------------
// History backfill — triggered when X-Musubi-Replay-Truncated signals
// the server couldn't fit all missed events into the 500-event replay cap.
// ------------------------------------------------------------------

type ThoughtHistoryItem = {
  readonly object_id: string;
  readonly content?: unknown;
  readonly [key: string]: unknown;
};

type ThoughtHistoryResponse = {
  readonly items: readonly ThoughtHistoryItem[];
};

type BackfillContext = {
  readonly client: MusubiClient;
  readonly namespace: string;
  readonly presence: string;
  readonly token: string;
  readonly dedup: BoundedDedupSet;
  readonly handlers: ThoughtStreamHandlers;
  readonly persistence: LastEventIdStore;
  readonly getRunning: () => boolean;
};

const BACKFILL_LIMIT = 1_000;

async function backfillHistory(ctx: BackfillContext): Promise<void> {
  const response = await ctx.client.post<ThoughtHistoryResponse>("/v1/thoughts/history", {
    body: {
      namespace: ctx.namespace,
      presence: ctx.presence,
      query_text: "*",
      limit: BACKFILL_LIMIT,
    },
    token: ctx.token,
  });

  const items = response.items ?? [];
  // Sort ascending by object_id so persistence advances monotonically.
  const sorted = [...items].sort((a, b) => {
    if (a.object_id < b.object_id) return -1;
    if (a.object_id > b.object_id) return 1;
    return 0;
  });

  // Read the current cursor so we never move it backwards.
  const cursor = await ctx.persistence.read();

  for (const item of sorted) {
    if (!ctx.getRunning()) break;

    const thought: ThoughtPayload = {
      object_id: item.object_id,
      content: typeof item.content === "string" ? item.content : "",
      from_presence: typeof item.from_presence === "string" ? item.from_presence : "",
      to_presence: typeof item.to_presence === "string" ? item.to_presence : "",
      namespace: typeof item.namespace === "string" ? item.namespace : ctx.namespace,
      sent_at: typeof item.sent_at === "string" ? item.sent_at : new Date().toISOString(),
    };
    if (ctx.dedup.add(thought.object_id)) {
      await ctx.handlers.onThought(thought);
      // Only advance the cursor forward (lex ascending); never backward.
      if (cursor === undefined || thought.object_id > cursor) {
        await ctx.persistence.write(thought.object_id);
      }
    }
  }
}
