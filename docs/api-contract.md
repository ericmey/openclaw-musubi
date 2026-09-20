# Active API consumer contract

> Current-state document. Re-establish the plugin claims with `npm test`,
> `openclaw plugins inspect musubi --runtime --json`, and—on a running
> provider—`openclaw musubi-doctor --agent <id>`.

This page describes the HTTP behavior the first-class OpenClaw provider
actually uses. The upstream Musubi canonical API remains authoritative for
server endpoint semantics; this page owns the client boundary.

## Authentication and identity

- Every request carries `Authorization: Bearer <materialized token>`.
- `core.token` and `core.perAgentTokens.*` are declared OpenClaw
  `secretInputs`; OpenClaw materializes structured SecretRefs before plugin
  registration.
- Any unresolved `${...}` string fails registration, including the hyphenated
  placeholder shape that caused the 2026-08-07 incident.
- Per-agent operations resolve both presence and token. A mapped agent without
  a mapped token fails strict delivery rather than falling back across an
  identity boundary.

The plugin does not parse token scopes locally or claim a request is authorized
before Musubi answers. `401` and `403` are authoritative, non-retryable auth
failures.

## Common HTTP behavior

- Base URL: `core.baseUrl`, with canonical endpoints under `/v1`.
- `X-Request-Id`: fresh for every HTTP call.
- `Idempotency-Key`: stable for one logical POST and reused by retries.
- Timeouts: `core.requestTimeoutMs`, defaulted by `src/config.ts`.
- Retryable: network failures, per-request timeouts, `5xx`, and `429`.
- Non-retryable: `401`, `403`, `404`, other client errors, and a request the
  caller aborted. Cancellation is terminal — retrying it would burn the whole
  attempt budget, and its backoff sleeps, re-aborting an abandoned request.
- `429` honors `Retry-After` in band up to `retry.maxRetryAfterMs` (60s,
  matching Musubi's own fixed 60s rate-limit window, so every value the
  server can legitimately emit is honored exactly). A longer wait is outside
  that contract and is returned to the caller instead, because an in-band
  sleep holds the delivery worker's drain lock and would stall every other
  queued row; the outbox schedules that wait durably.

## Durable completed-turn and explicit-store delivery

The delivery boundary is local SQLite, not a successful network response:

1. Resolve the calling agent's presence and token.
2. Commit the canonical payload and stable idempotency identity to the outbox.
3. Read the row back before the hook or tool reports it queued.
4. Before replaying an attempted POST, search for the receipt tag. A degraded
   receipt query defers delivery rather than risking a duplicate.
5. `POST /v1/episodic` and persist the returned canonical `object_id`.
6. `GET /v1/episodic/{id}?namespace=...` and compare object id, namespace, and
   content SHA-256.
7. Only then mark the row `verified` and prune plaintext from the outbox.

`401`, `403`, invalid write envelopes, readback identity mismatches, and local
faults such as a corrupt ledger row become durable `dead` rows. Only failures
that are positively classified retryable — transport, timeout, `5xx`, `429`,
and a degraded receipt envelope — remain pending with bounded backoff; an
unrecognized error dead-letters rather than retrying indefinitely.

Delivery cancelled by shutdown is neither: the lease is released without
recording a failure, so restarts do not walk a healthy provider toward
`degraded`.

### Episodic content ceiling

Musubi rejects a capture over 32768 UTF-8 bytes with `422 CONTENT_TOO_LARGE`,
and a `422` is terminal — so an oversized turn dead-letters and the memory is
gone. The plugin handles the two paths differently, because the reader is
different:

- **Passive capture** is truncated to fit, with the cut stated in the body and
  the row tagged `openclaw:truncated`. Nobody is watching a completed turn to
  notice a failure and retry it, so keeping most of the memory beats losing
  all of it. Truncation happens before the outbox hashes the payload, so
  `content_sha256` still matches the bytes the server stores.
- **`musubi_remember` is refused** with the limit and a suggestion to split.
  An agent chose those words and can see the tool result, so a refusal it can
  act on beats silently storing something shorter than it asked for.

The limit is measured in bytes, not characters: a 32k-character slice of
non-ASCII text is still oversized.

## Retrieval

### Semantic search

`memory_search` and `musubi_search` call `POST /v1/retrieve` with:

- `mode: "deep"`;
- the caller's query and requested planes;
- `state_filter: ["provisional", "matured", "promoted"]`; and
- the calling presence's token.

Server warnings and partial target failures are printed in the tool result. A
degraded envelope is never rendered as an ordinary “no memory” answer.

### Exact object read

`memory_get` and `musubi_get` call the plane-specific canonical GET using the
object id and namespace returned by search.

### Recent episodic activity

`musubi_recent` calls `POST /v1/retrieve` with `mode="recent"` — the
query-free recency pipeline — scoped to the presence's own episodic
namespace, with `state_filter: ["provisional", "matured", "promoted"]`.

`tags` (AND semantics) and `since` are SERVER-side filters in that mode, so
they apply across the whole namespace rather than to one returned page. This
is load-bearing, not incidental: the earlier `GET /v1/episodic` fallback
filtered the page it got back, and that endpoint's page order is Qdrant
scroll order rather than recency — so a filter could silently miss matches
that simply were not on the page. A memory tool reporting "nothing" when the
memory exists is the one failure this surface cannot have.

`since` goes on the wire as epoch SECONDS; the server explicitly rejects ISO
strings. The tool's own parameter stays ISO-8601 and converts.

Recent rows carry `score_kind: "created_epoch"` — `score` IS the source
timestamp — so recency ordering and display need no per-row date enrichment,
unlike ranked retrieval.

Rows the server flagged `content_truncated` are rendered with the cut marked
and a pointer to `musubi_get`, in both recent and ranked results. A slice is
never presented as the whole object.

## Deep operator proof

`openclaw musubi-doctor --agent <id>` is explicit and mutating. It:

1. queues a unique diagnostic through the same SQLite outbox as a real turn;
2. waits for canonical GET verification;
3. requires semantic retrieval to return that exact object; and
4. soft-archives the diagnostic with `DELETE /v1/episodic/{id}?namespace=...`.

A cleanup failure makes the doctor fail. The doctor never runs at startup.

## Status and degradation

`/musubi-status`, gateway method `musubi.status`, and `openclaw musubi-status`
report local provider truth: service running state, pending and dead rows,
oldest pending age, failure streak, and last verified delivery. They do not
claim to be remote-core health probes.

`degraded` is driven by deaths inside a 24h window, not by the lifetime `dead`
count: a row that died last month stays visible and inspectable for 30 days,
but must not pin the provider to `degraded` forever with no way to clear it.

## Thoughts boundary

Outbound `musubi_think` uses `POST /v1/thoughts/send`. The former inbound SSE
consumer is not shipped in this release: it had no verified path from a
received event into OpenClaw context. The protocol is documented only as
historical reference in `architecture/transport.md`; it is not part of the
active provider contract.
