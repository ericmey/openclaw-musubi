# API Consumer Contract

This document captures the **client-side behavior** any Musubi consumer
must implement. It mirrors the "Consumer expectations" section of the
upstream Musubi v2 canonical API spec
(`docs/architecture/07-interfaces/canonical-api.md` §5 Thoughts →
"Consumer expectations") so this plugin, the LiveKit worker, and any
future Python homelab consumer all build to the same contract.

When the upstream spec and this file disagree, **the upstream spec wins**.
Open a PR updating this file to match, and link the upstream change in the
description.

## Source of truth

- Locked in upstream Musubi PR
  [#103](https://github.com/ericmey/musubi/pull/103).
- Section: `docs/architecture/07-interfaces/canonical-api.md`, §5 Thoughts,
  "Thoughts stream (SSE)" and "Consumer expectations".

## HTTP

### Base URL and versioning

- All endpoints live at `<core.baseUrl>/v1/…`.
- The plugin probes `GET /v1/ops/status` at load and logs the reported
  Musubi version. Mismatches between the plugin's `peerDependencies`
  range and the reported version surface as warnings, not errors.

### Authentication

- Every request includes `Authorization: Bearer <token>`.
- Tokens are presence-scoped. The plugin does not attempt a request it
  knows is out of the token's scope; it fails fast with a typed error and
  logs the missing scope.

### Headers

| Header | Direction | Purpose |
|---|---|---|
| `Authorization` | → | Bearer token. |
| `X-Request-Id` | → | Per-request correlation id. Echoed by server in logs. |
| `Idempotency-Key` | → (writes only) | Fresh per logical operation; retries reuse the same key. |
| `Retry-After` | ← | Honored on `429` and `503`. |

### Error taxonomy

Typed errors the client distinguishes:

- **Network** — connection refused, DNS fail, read timeout. Retry with
  backoff.
- **Auth (`401`/`403`)** — token missing, invalid, expired, or out of
  scope. No retry; surface to user.
- **Rate limit (`429`)** — honor `Retry-After`, then retry.
- **Server (`5xx`)** — retry with backoff up to a small cap, then fail.
- **Client (`4xx` other)** — treat as programming error; log full detail;
  do not retry.

### Retries

- Network and `5xx`: exponential backoff `min(2^n * 500ms + rand(0,250ms),
  8s)` for up to 5 attempts.
- `429`: honor `Retry-After`.
- Writes: always include `Idempotency-Key` so retries are safe.

### Timeouts

- Per-request default: 30 seconds.
- Override: `core.requestTimeoutMs` in plugin config.
- SSE connection has no request timeout; it has a **ping-gap timeout** of
  60 seconds (see below).

## SSE: `/v1/thoughts/stream`

The full transport description is in
[`architecture/transport.md`](./architecture/transport.md). The **six
normative client rules** from the upstream spec are reproduced here so
consumer reviewers can audit a client's compliance without cross-doc
hopping:

### 1. Exponential backoff with jitter on drop

```
delay_ms = min(2^n * 1000 + rand(0, 1000), 60_000)
```

`n` starts at 0, increments each failed attempt, resets to 0 after the
connection remains stable for 5 minutes. Upper bound is configurable via
`thoughts.reconnect.maxBackoffMs` but must not go below 60s without an
operational reason documented in config.

### 2. Persist `Last-Event-ID` across restarts

The client stores the most recent acknowledged `id:` value in durable
storage scoped to the plugin. In OpenClaw that's the plugin's state
store; in a browser extension it's `chrome.storage.local` or IndexedDB; in
a Python consumer it's a file or KV entry. Losing the id replays the
entire plane on next connect.

### 3. Bounded local dedup set

Keep the last **1000** `object_id`s or a **1-hour TTL**, whichever bound
is hit first. Replay on reconnect and in-flight delivery may overlap; the
set skips duplicates.

### 4. Scope-mismatch handling

`403 Forbidden` on the initial GET is a token-scope problem. Clients must
**not** reconnect on 403. Surface a user-visible status ("Musubi
authentication needs refresh") and wait for operator action.

### 5. Ping-gap timeout

Server sends `event: ping` every 30 seconds. If **no frame of any kind**
(thought, ping, close) arrives in 60 seconds (2× the ping interval), the
connection is presumed dead. The client closes its side, which triggers
the normal reconnect path. This catches silent half-open TCPs that VPNs
and corporate proxies can produce.

### 6. Lexicographic ID comparison

`object_id` is a **KSUID** — 27 characters, base62. Compare as strings,
not as numbers. `"2iVVRLuCj..." > "2iVVRLuAh..."` is the correct ordering
for sort, dedup insertion, and `Last-Event-ID` replay cursor selection.

## Fanout is broadcast (normative)

Two clients subscribed to the same presence **each receive every event**.
A plugin instance must not assume it "owns" a presence's stream. This
matters because:

- A user may have two browsers open and a LiveKit worker all subscribed
  to `eric/aoi` — all three are expected to see every thought.
- The plugin handles this by relying on the dedup set (rule 3) for any
  in-process deduplication, not by assuming single-consumer semantics.

The upstream spec marks this as normative and not-to-be-regressed. The
plugin depends on it and will not add "only one tab should receive" logic.

## Write-path expectations

### Episodic capture

- Single: `POST /v1/episodic`. Idempotency-Key recommended, required on
  retry.
- Batch: `POST /v1/episodic/batch`. Used by the capture-mirror hook when
  OpenClaw flushes multiple memories at once.

### Thoughts

- Send: `POST /v1/thoughts/send`. Idempotent on client-provided
  `client_id` in the body (KSUID minted by the client).
- Check (polling fallback): `POST /v1/thoughts/check`. Used when the SSE
  stream is unavailable or disabled.

### Curated

- The plugin reads curated but does not write by default. A future
  `musubi_curate` tool may let agents propose curated additions; those go
  through Musubi's normal curated-write path (`POST /v1/curated`) with
  appropriate scope.

## Read-path expectations

### Retrieve

- `POST /v1/retrieve` with `mode: "fast"` for prompt-supplement reads
  (must return within the prompt-build latency budget).
- `POST /v1/retrieve` with `mode: "deep"` for the explicit `musubi_recall`
  tool (agent-triggered, no strict latency budget).

### Planes

- The supplement reads from `curated` and `concept` by default. Operators
  may add `episodic` if they want recent-episodic context in the prompt
  as well, but this is off by default because episodic is noisy.

## Health and degradation

- `GET /v1/ops/health` — simple liveness probe.
- `GET /v1/ops/status` — per-component status, once
  `slice-ops-observability` ships upstream. The plugin surfaces the
  reported degraded components in its config-UI status panel.
- If the core is unreachable, the plugin serves empty supplements and
  fails recall/remember/think tools with a typed error. It does not
  prevent OpenClaw's native memory engine from running.
