# Transport

The plugin talks to a Musubi core over two transports:

- **HTTP** for request/response work — retrieval queries, episodic captures,
  curated reads, thought send/check/history, health probes.
- **Server-Sent Events** for real-time inbound thought delivery.

Both share the same base URL and bearer token. A future gRPC streaming
transport is anticipated upstream; when it lands, this plugin will add it
behind the same configuration surface. Until then, everything below.

> The HTTP and SSE surfaces on the server are specified in the Musubi v2
> repo at `docs/architecture/07-interfaces/canonical-api.md`. That document
> is the source of truth. This page describes client behavior that mirrors
> its normative requirements.

## HTTP

### Base URL

Configured at `core.baseUrl`. All endpoints are rooted at `<baseUrl>/v1/…`.

### Authentication

Every request sends `Authorization: Bearer <token>`. Tokens carry a
presence identity and namespace scopes — see
[Presence model](./presence-model.md) for the token-scoping rules.

### Headers

- `X-Request-Id` — the plugin generates one per outbound request so server
  logs and client logs share a correlation id.
- `Idempotency-Key` — on POSTs that write, the plugin generates a fresh
  key so retries don't double-write.

### Retries

Network errors and `5xx` responses are retried with exponential backoff.
`4xx` is not retried except `429 Too Many Requests` (honors `Retry-After`).

### Timeouts

Per-request timeout defaults to 30s, configurable via `core.requestTimeoutMs`.

## SSE: `/v1/thoughts/stream`

The plugin subscribes to `/v1/thoughts/stream` for each configured presence
to receive inbound thoughts without polling.

### Request shape

```
GET /v1/thoughts/stream?namespace=<presence>&include=<filter>
Accept: text/event-stream
Authorization: Bearer <token>
Last-Event-ID: <optional — KSUID of last seen thought; triggers replay>
```

`namespace` is the configured presence. `include` defaults to
`<presence-slug>,all` (the two values that normally target a given
presence); operators may override.

### Event types the client handles

- **`event: thought`** — one per delivered thought. The SSE `id:` field is
  the thought's `object_id`, a 27-character base62 KSUID. The body is
  JSON with `object_id`, `from_presence`, `to_presence`, `namespace`,
  `content`, `channel`, `importance`, `sent_at`.
- **`event: ping`** — keepalive, every 30 seconds. No action beyond
  bumping the "last-frame-seen" timestamp.
- **`event: close`** — graceful shutdown signal with an optional
  `reconnect_after_ms`. Client waits the hinted delay then reconnects.

### Replay on reconnect

The client persists the most recent `id:` it has acknowledged and, on
reconnect, sends it back as the `Last-Event-ID` request header. Server
replays every thought in the subscription where `object_id > <ksuid>` in
lexicographic order before entering live-tail mode. Because KSUIDs sort by
time, this is a cheap range query.

**Comparison is lexicographic, not numeric.** `"2iVVRLuCj…" > "2iVVRLuAh…"`
is the correct ordering.

### Fanout is broadcast

Multiple simultaneous subscriptions to the same presence **each receive
every event**. If a user has two browsers open and a LiveKit worker all
subscribed to `eric/aoi`, all three see every thought addressed to Aoi.
This is normative in the upstream spec and the plugin depends on it — the
client never assumes it owns the stream for a presence.

### Backpressure

The server drops in-memory events for slow consumers. No data loss: the
thoughts are durable in Qdrant, and a reconnect with `Last-Event-ID`
recovers them. The client therefore must not rely on the stream alone for
append-ordering; it treats the stream as "eventually complete via replay."

### Connection cap

The server caps concurrent SSE streams per API process at 100 in v1.0.
Over-cap connections receive `503 Service Unavailable` with
`Retry-After: 5`. The client honors `Retry-After` and retries.

## Consumer expectations (client contract)

These are the contract every `/thoughts/stream` subscriber — this plugin,
the LiveKit worker, and any future consumer — must honor. They mirror the
"Consumer expectations" section of the upstream canonical-api spec
verbatim so behavior stays aligned across implementations.

1. **Exponential backoff with jitter on drop.**
   `delay_ms = min(2^n * 1000 + rand(0, 1000), 60_000)` where `n` starts
   at 0 and increments each failed attempt. Reset `n` to 0 after 5 minutes
   of stable connection. Upper bound is overridable via
   `thoughts.reconnect.maxBackoffMs`, but never below 60s without very
   good reason.
2. **Persist `Last-Event-ID` across restarts.** The plugin uses OpenClaw's
   plugin-scoped state store. Losing the ID replays the entire plane.
3. **Bounded local dedup set** of the last 1000 `object_id`s or a 1-hour
   TTL, whichever bound is hit first. Replay and in-flight frames can
   overlap during a reconnect; any `object_id` already in the set is
   skipped.
4. **Scope-mismatch handling.** `403 Forbidden` on the initial GET is a
   token-scope problem. Do **not** reconnect on 403 — that would hammer
   the server with calls that will never succeed. Bubble a user-visible
   "re-authenticate Musubi" status.
5. **Ping-gap timeout** of 60s (two ping intervals). If no frame of any
   kind arrives in that window, the connection is presumed dead; the
   client closes its side to trigger the normal reconnect path. Catches
   silent half-open TCPs behind VPNs and proxies.
6. **Lexicographic ID comparison** everywhere an `object_id` is compared
   (replay ordering, dedup-set insertion, persisted-id staleness checks).
   Never parse as an integer.

## Failure and degraded modes

- **Musubi core unreachable at startup.** The client enters the reconnect
  loop immediately. HTTP operations return typed errors to callers; the
  memory supplement returns empty rather than failing the prompt build.
- **Token expired or scope revoked.** `401`/`403` surface a user-visible
  status. SSE stays disconnected; HTTP operations fail fast with a typed
  error.
- **Slow stream / backpressure.** Handled transparently by the server's
  drop + client's replay. No user-visible effect.
- **OpenClaw plugin host shutdown.** The client closes its SSE connection
  cleanly and persists the last `id:` seen so the next load resumes
  without loss.
