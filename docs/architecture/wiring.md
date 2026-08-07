# Plugin wiring

> Current-state document. Verify with `npm test` and the loader-backed
> `tests/plugin/loader-smoke.test.ts`.

Entry point: `src/index.ts` delegates synchronously to
`registerMusubi(...)` in `src/plugin/bootstrap.ts`.
The deployment contract selects `plugins.slots.memory = "musubi"`.

## Registration

Registration is side-effect free but fail-closed:

1. TypeBox validates the materialized config.
2. Every token is checked for unresolved `${...}` syntax, including hyphenated
   placeholders that caused the 2026-08-07 incident.
3. One exclusive memory capability is registered.
4. Native and canonical Musubi tools are registered as per-agent factories.
5. The `agent_end` hook, host-owned service, gateway status method, slash
   command, and CLI status command are registered.

No promise catches registration failure. Invalid configuration reaches the
OpenClaw loader and cannot become a plugin reported as loaded but inert.

## Host-owned service

`registerService({ id: "musubi-memory" })` owns all long-lived state:

- SQLite outbox at `<stateDir>/musubi/delivery-outbox.sqlite`;
- lease recovery and delivery worker;
- deterministic shutdown.

The old inbound thought SSE subscriber is not registered. Its handler did not
deliver received thoughts into OpenClaw context, so starting it would consume a
durable event without providing the advertised capability. Outbound
`musubi_think` remains a separate tool.

Discovery and validation modes see registration metadata without opening
sockets or databases. The full host service creates runtime state at start and
closes it at stop.

## Capture ordering

```text
translate whole turn
  -> resolve per-agent presence/token
  -> INSERT ... ON CONFLICT DO NOTHING
  -> SELECT row and verify identity binding
  -> return from agent_end
  -> background claim/lease
  -> receipt lookup when replaying
  -> POST /v1/episodic
  -> persist accepted object_id
  -> GET canonical object
  -> compare object_id + namespace + sha256(content)
  -> mark verified and prune plaintext payload
```

Crash boundaries are explicit: a committed pending row survives restart; an
accepted row never repeats POST; an orphaned lease returns to pending or
accepted based on whether `object_id` was persisted.

## Runtime verification

```bash
npm run build
npm test
openclaw plugins inspect musubi --runtime --json
openclaw musubi-status
openclaw musubi-doctor --agent vesper
```

The loader smoke creates an isolated OpenClaw state/config, selects Musubi in
the memory slot, loads the built package through the real 2026.7.1 runtime,
and verifies that the authored config is not mutated.

The doctor is the end-to-end runtime proof. It uses the provider's durable
outbox rather than bypassing it with a direct write, verifies canonical readback
and semantic retrieval, and soft-archives its diagnostic object afterward.
