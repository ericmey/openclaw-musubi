# ADR-0002: Server-Sent Events for thought delivery

- **Status:** Accepted
- **Date:** 2026-04-19
- **Deciders:** @ericmey, Aoi (OpenClaw), Aoi (Musubi)

## Context

Musubi v2 ships a presence-to-presence "thoughts" plane: a presence (e.g.,
`eric/aoi`) sends a thought addressed to another presence (e.g.,
`eric/openclaw`), and the recipient surfaces it. The initial v2 surface
exposed only **polling**: `POST /v1/thoughts/check` returns the current
unread set.

Polling works but trades latency or load for simplicity:

- Tight intervals (e.g., 1s) waste CPU and network across every consumer
  for the rare event-arrival case.
- Loose intervals (e.g., 30s+) make "tell my Discord-facing agent
  something" feel sluggish — exactly the case the feature exists for.

For OpenClaw to surface inbound thoughts in agent context without that
penalty, we need push semantics. The transport options are:

1. **Webhooks** — server POSTs to a callback URL when a thought arrives.
2. **WebSockets** — long-lived bidirectional channel.
3. **Server-Sent Events (SSE)** — long-lived server-to-client stream over
   HTTP.
4. **gRPC streaming** — bidirectional or server-streaming RPC.

## Decision

**We use Server-Sent Events.** The Musubi server exposes
`GET /v1/thoughts/stream` and the plugin maintains a long-lived SSE
subscription per configured presence.

Behavior is locked in upstream Musubi PR
[#103](https://github.com/ericmey/musubi/pull/103) and reflected in this
plugin's [`docs/api-contract.md`](../api-contract.md).

## Alternatives considered

### Webhooks

Tempting because it is the canonical "push" pattern and zero work for
quiescent consumers. Rejected because:

- **Browser extensions cannot receive webhooks.** A service worker has no
  public URL; it can only initiate connections. Supporting browser
  extensions natively is a goal of this plugin family. A webhook design
  paints us into a corner where browser-resident consumers need a
  separate broker (Lambda, Cloudflare Worker) — extra infra we should
  not require.
- Webhook delivery requires the server to track per-consumer URLs,
  signatures, retries, and dead-letter handling — all production
  infrastructure that does not yet exist on the Musubi side.

### WebSockets

Tempting because it is bidirectional and well-supported. Rejected for
v1.0 because:

- Bidirectionality is unused by the immediate use case (consumers
  receive; senders use the existing `POST /thoughts/send`).
- Adds a separate framing protocol to authenticate, version, and operate.
- Provides no advantage SSE doesn't already provide for one-way push
  over HTTP.

### gRPC streaming

Tempting because gRPC streaming is on Musubi's roadmap for retrieval
streams. Rejected for v1.0 because:

- Browser support is limited (gRPC-Web requires a proxy and lacks full
  streaming semantics).
- Musubi has no production gRPC surface yet; building one for this
  feature would block both projects.
- When the gRPC surface lands, this plugin can add it behind the same
  configuration knob without changing the consumer contract above HTTP.

### SSE — chosen

Adopted because it:

- Works in **every consumer environment** we care about: browser
  extension service workers, Node.js, Python `httpx.stream`, the LiveKit
  Python worker.
- **Matches Musubi's existing surface shape** — `POST /retrieve/stream`
  already uses SSE-style streaming. Consumers, ops, and auth all reuse
  patterns already proven.
- Has trivially recoverable behavior on drop: `Last-Event-ID` triggers a
  bounded server-side range query against the durable thoughts plane.
  KSUID `object_id`s sort lexicographically by time so replay is cheap.
- Works through every corporate proxy and VPN we have data on, given the
  spec'd 30-second `event: ping` keepalive.

## Consequences

### What this commits us to

- The plugin maintains one long-lived TCP connection per configured
  presence subscription.
- The plugin implements **all six** consumer-expectations rules (backoff
  + jitter, persisted `Last-Event-ID`, bounded dedup set, scope-mismatch
  handling, ping-gap timeout, lex comparison) — see
  [`docs/api-contract.md`](../api-contract.md).
- Multi-consumer fanout is **broadcast** (normative upstream): the plugin
  must not assume it is the only subscriber for a presence and must
  dedup against its own seen-set.

### What it gets us

- Inbound thoughts surface within the network round-trip plus
  prompt-build latency, not within polling-interval.
- Reconnect-on-drop is automatic and lossless via replay.
- The same protocol works for the future LiveKit worker, Python homelab
  consumers, and any external integration without rework.

### What it does not get us

- Bidirectional channel — outbound thoughts still go through `POST
  /v1/thoughts/send`. Acceptable; the plugin can multiplex sends onto an
  HTTP/2 connection alongside the SSE stream.
- Lifecycle/contradiction streams — not in scope for this ADR. The
  in-process broker that powers `/thoughts/stream` is intended to be
  reused for those streams later, but they ship as separate slices.

## References

- Upstream spec: `docs/architecture/07-interfaces/canonical-api.md` §5
  Thoughts → "Thoughts stream (SSE)" and "Consumer expectations".
- Upstream PR: https://github.com/ericmey/musubi/pull/103
- Upstream implementation issue: https://github.com/ericmey/musubi/issues/102
- ADR-0001 (sidecar-with-authority) — the integration model this
  transport choice serves.
