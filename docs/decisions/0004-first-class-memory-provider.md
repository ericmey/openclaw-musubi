# ADR-0004: Musubi owns the OpenClaw memory slot

- **Status:** Accepted
- **Date:** 2026-08-07
- **Supersedes:** [ADR-0001](./0001-sidecar-with-authority.md)
- **Decision owner:** Eric Mey
- **Verification:** `npm test`; `openclaw plugins inspect musubi --runtime --json`

## Context

ADR-0001 selected an additive companion before the current Musubi durability,
correction, receipt, and lifecycle work existed. The deployed system later had
`plugins.slots.memory = "none"`, while the companion never delivered because
hyphenated `${...}` token placeholders remained literal. All eight agent
namespaces had zero rows. Static identity files and local transcripts survived,
but no provider supplied cross-session recall.

The old ADR then confused the repair: it suggested restoring `memory-core`
instead of asking what the intended architecture had become. OpenClaw 2026.7.1
ships a direct precedent for plugin-owned memory slots (`memory-lancedb`) and
enforces capability ownership through the loader.

## Decision

Musubi is the exclusive first-class memory provider for this OpenClaw
deployment and for the plugin's supported architecture.

- The manifest and exported definition declare `kind: "memory"`.
- The plugin registers `registerMemoryCapability(...)`.
- Deployment selects `plugins.slots.memory = "musubi"`.
- Native `memory_search`, `memory_get`, and `memory_store` tools route to
  Musubi, alongside canonical Musubi tool names.
- Completed turns enter a durable local outbox before hook return.
- POST acceptance is not storage proof; canonical GET readback establishes
  verified delivery.
- 401/403, retry backlog, and readback mismatch remain durable and visible.
- Existing local transcripts are imported only after live write, readback, and
  retrieval prove green for every agent.

Musubi does not implement or pretend to implement the builtin/qmd local memory
runtime. Its first-class capability is expressed through plugin-owned tools,
prompt guidance, capture, health, and durability.

## Consequences

- `memory-core` is not restored as an intermediate or parallel primary.
- Additive prompt/corpus supplements are removed from active registration.
- The former `supplement` and `capture.mirrorOpenClawMemory` config fields are
  accepted for one migration release but do not define the architecture.
- A Musubi outage is a real provider degradation, so the plugin must expose
  durable backlog and operator status rather than silently returning empty.
- Documentation parity becomes a release gate: manifest kind, runtime kind,
  selected-slot examples, registered capability, and current architecture
  wording must agree.

## Re-verification

Do not treat this ADR's date as proof. Re-establish the implementation claim:

```bash
npm run typecheck
npm run lint
npm test
openclaw plugins inspect musubi --runtime --json
```
