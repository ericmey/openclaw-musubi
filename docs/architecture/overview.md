# Architecture overview

> Current-state document. Re-verify with `npm test` and
> `openclaw plugins inspect musubi --runtime --json`; do not infer live state
> from this page's age.

## Role

Musubi is OpenClaw's selected first-class memory provider. The plugin is a
careful remote-service adapter: durable local delivery, per-agent identity,
native memory tools, and provider health live here; lifecycle, retrieval,
planes, and canonical object storage live in Musubi.

The active topology is:

```text
OpenClaw agent turn
  -> agent_end hook
  -> local SQLite outbox (committed + read back)
  -> delivery worker
  -> Musubi POST acceptance
  -> persisted object_id
  -> canonical GET readback
  -> verified

OpenClaw memory_search / memory_get / memory_store
  -> per-agent presence + token resolution
  -> Musubi canonical API
```

The plugin declares `kind: "memory"`, registers
`registerMemoryCapability(...)`, and is selected by
`plugins.slots.memory = "musubi"`. It does not register additive corpus or
prompt supplements and it does not restore `memory-core` as a parallel
primary. [ADR-0004](../decisions/0004-first-class-memory-provider.md) is the
current decision; ADR-0001 is historical.

## Memory behavior

### Completed-turn capture

The capture adapter selects the final assistant response and its nearest
preceding user message, excludes tool/system payloads, and derives a stable
source identity from the run id or a SHA-256 digest of agent, session, and
content. The hook returns only after SQLite commits and reads back the outbox
row. It never waits for the network and never calls a failed delivery
"captured."

### Delivery truth

The ledger distinguishes `pending`, `inflight`, `accepted`, `verified`, and
`dead`. POST success is acceptance, not storage proof. The canonical GET must
match object id, namespace, and content digest before a row becomes verified.
Before replaying an attempted write, the worker performs receipt lookup; if
that lookup is unavailable or degraded, it defers rather than risk a duplicate.

### Native tools

- `memory_search` / `musubi_search`: semantic retrieval across readable planes.
- `memory_get` / `musubi_get`: exact object readback by plane, namespace, and id.
- `memory_store` / `musubi_remember`: durable explicit capture. Results say
  `verified`, `queued`, or `dead`; accepted POSTs are never called remembered.
- `musubi_recent`, `musubi_think`, and the temporary `musubi_recall` alias retain
  the broader canonical Musubi surface.

### Prompt and compaction

The exclusive capability contributes synchronous tool guidance only. It does
not inject a global remote-result cache because one shared cache could put one
agent's presence into another agent's prompt. Completed turns are already
durably queued at `agent_end`, so Musubi does not claim OpenClaw's
file-oriented pre-compaction flush plan. This is deliberate provider behavior,
not an omitted sidecar fallback.

## Degraded behavior

- Invalid config or unresolved `${...}` credentials fail registration before
  the capability is advertised.
- A local SQLite enqueue failure is logged as an operator-visible capture
  failure and never rounded to success.
- Retryable transport failures remain durable with bounded backoff.
- 401/403 and identity/readback mismatches become `dead` rows.
- Status distinguishes plugin registration, service running state, queue
  backlog, dead rows, oldest pending age, failure streak, and last verified
  delivery.

## Non-goals

- Implement OpenClaw's builtin/qmd local search-manager runtime. Musubi owns a
  remote service and must not fabricate `dbPath`, chunk counts, or local backend
  identity.
- Run a Musubi core inside the plugin.
- Treat documentation as runtime proof. Current-state claims must remain tied
  to the commands at the top of this page.
