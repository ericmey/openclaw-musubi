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
- Retryable: network failures, `5xx`, and `429` after `Retry-After`.
- Non-retryable: `401`, `403`, `404`, and other client errors.

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

`401`, `403`, invalid write envelopes, and readback identity mismatches become
durable `dead` rows. Retryable failures remain pending with bounded backoff.

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

`musubi_recent` calls `GET /v1/episodic?namespace=...&limit=...`, applies
optional tags and time filters, then sorts timestamps client-side because the
underlying page order is not a recency guarantee.

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

## Thoughts boundary

Outbound `musubi_think` uses `POST /v1/thoughts/send`. The former inbound SSE
consumer is not shipped in this release: it had no verified path from a
received event into OpenClaw context. The protocol is documented only as
historical reference in `architecture/transport.md`; it is not part of the
active provider contract.
