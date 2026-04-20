# Documentation

This folder is the authoritative design surface for `openclaw-musubi`.
Implementation slices trace back to these documents; when a doc and the code
disagree, we update one or the other in the same PR.

## Start here

- [Architecture overview](./architecture/overview.md) — what the plugin is,
  what it does, and the sidecar-with-authority integration model.
- [Presence model](./architecture/presence-model.md) — how OpenClaw agents
  map to Musubi presences, how tokens are scoped.
- [Transport](./architecture/transport.md) — HTTP for request/response work,
  Server-Sent Events for live thought delivery, reconnect and backoff rules.

## Contracts

- [API consumer contract](./api-contract.md) — the behavior any Musubi-client
  must implement. Mirrors the consumer-expectations section of the upstream
  Musubi canonical-api spec so both sides build to the same doc.

## Decisions

See [`decisions/`](./decisions/) for Architecture Decision Records (ADRs).
Every load-bearing choice lands as an ADR so future contributors can
reconstruct **why** — not just what.

## Related external documentation

- [Musubi v2 architecture](https://github.com/ericmey/musubi/tree/v2/docs/architecture)
  — the upstream memory-core design, especially `01-overview/three-planes.md`
  and `07-interfaces/canonical-api.md`.
- [OpenClaw plugin docs](https://github.com/openclaw/openclaw/tree/main/docs/plugins)
  — SDK overview, manifest schema, plugin capability reference.
