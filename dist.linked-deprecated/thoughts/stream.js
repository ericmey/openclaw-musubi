import { resolvePresence } from "../presence/resolver.js";
import { nextSseBackoffMs } from "./backoff.js";
import { BoundedDedupSet } from "./dedup.js";
import { InMemoryLastEventIdStore } from "./persistence.js";
const DEFAULT_PING_TIMEOUT_MS = 60_000;
const DEFAULT_STABLE_RESET_MS = 5 * 60_000;
const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function createThoughtStream(options) {
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
    let abortController;
    let attempt = 0;
    const stream = {
        isRunning: () => running,
        __backoffAttempt: () => attempt,
        async stop() {
            running = false;
            abortController?.abort();
        },
        async start(handlers) {
            if (running)
                return;
            running = true;
            attempt = 0;
            let presence;
            try {
                presence = resolvePresence(config, { agentId: options.agentId });
            }
            catch {
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
                    }
                    catch {
                        // Backfill is best-effort; ignore errors and reconnect normally.
                    }
                }
                handlers.onDisconnect?.(outcome.kind);
                const stableDuration = now() - connectedAtCandidate;
                if (outcome.connected && stableDuration >= stableResetMs) {
                    attempt = 0;
                }
                let delayMs;
                if (outcome.kind === "close" && outcome.reconnectAfterMs !== undefined) {
                    delayMs = outcome.reconnectAfterMs;
                }
                else if (outcome.kind === "http-error" && outcome.retryAfterMs !== undefined) {
                    delayMs = outcome.retryAfterMs;
                }
                else {
                    delayMs = nextSseBackoffMs(attempt, { random, maxDelayMs: maxBackoffMs });
                }
                attempt += 1;
                await sleep(delayMs);
            }
        },
    };
    return stream;
}
function buildStreamUrl(baseUrl, presence, include) {
    const params = new URLSearchParams({ namespace: presence });
    if (include !== undefined)
        params.set("include", include);
    return `${baseUrl}/v1/thoughts/stream?${params.toString()}`;
}
async function runOneConnection(ctx) {
    const controller = new AbortController();
    ctx.setAbortController(controller);
    let pingTimer;
    let pingGapTriggered = false;
    const resetPingTimer = () => {
        if (pingTimer)
            clearTimeout(pingTimer);
        pingTimer = setTimeout(() => {
            pingGapTriggered = true;
            controller.abort();
        }, ctx.pingTimeoutMs);
    };
    const lastSeenId = await ctx.persistence.read();
    const headers = {
        Authorization: `Bearer ${ctx.token}`,
        Accept: "text/event-stream",
        "Cache-Control": "no-cache",
    };
    if (lastSeenId !== undefined) {
        headers["Last-Event-ID"] = lastSeenId;
    }
    let response;
    try {
        response = await ctx.fetch(ctx.url, {
            method: "GET",
            headers,
            signal: controller.signal,
        });
    }
    catch {
        if (pingTimer)
            clearTimeout(pingTimer);
        return { kind: "network-error", connected: false };
    }
    if (response.status === 401 || response.status === 403) {
        if (pingTimer)
            clearTimeout(pingTimer);
        return { kind: "auth-fail", status: response.status, connected: false };
    }
    if (!response.ok || !response.body) {
        if (pingTimer)
            clearTimeout(pingTimer);
        const retryAfterMs = response.status === 503
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
                const thought = safeJsonParse(frame.data);
                if (thought === undefined)
                    continue;
                const id = frame.id ?? thought.object_id;
                if (ctx.dedup.add(id)) {
                    await ctx.handlers.onThought(thought);
                    await ctx.persistence.write(id);
                }
            }
            else if (frame.event === "close") {
                const data = safeJsonParse(frame.data);
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
    }
    catch {
        if (pingGapTriggered) {
            return { kind: "ping-gap-timeout", connected: true, truncated };
        }
        return { kind: "stream-error", connected: true, truncated };
    }
    finally {
        if (pingTimer)
            clearTimeout(pingTimer);
    }
}
async function* parseSseStream(body) {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let event = "";
    let id;
    let dataLines = [];
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
                }
                else if (line.startsWith("id:")) {
                    id = line.slice(3).replace(/^ /, "");
                }
                else if (line.startsWith("data:")) {
                    dataLines.push(line.slice(5).replace(/^ /, ""));
                }
                // Other field names (retry:) are accepted by spec but unused here.
            }
            if (done)
                break;
        }
    }
    finally {
        reader.releaseLock();
    }
}
function safeJsonParse(raw) {
    try {
        return JSON.parse(raw);
    }
    catch {
        return undefined;
    }
}
function parseRetryAfter(header, now = Date.now) {
    if (header === null)
        return undefined;
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
const BACKFILL_LIMIT = 1_000;
async function backfillHistory(ctx) {
    const response = await ctx.client.post("/v1/thoughts/history", {
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
        if (a.object_id < b.object_id)
            return -1;
        if (a.object_id > b.object_id)
            return 1;
        return 0;
    });
    // Read the current cursor so we never move it backwards.
    const cursor = await ctx.persistence.read();
    for (const item of sorted) {
        if (!ctx.getRunning())
            break;
        const thought = {
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
//# sourceMappingURL=stream.js.map