# Architecture Overview

## The problem

OpenClaw agents live in many modalities at once. The same named agent might
run as a CLI session, a Discord-facing worker, a LiveKit voice call, and a
browser companion — often for the same human. Each modality has its own
short-term memory, and OpenClaw ships a native long-term memory plugin
family (`memory-core`, `memory-lancedb`, `memory-wiki`). But none of those
know what's happening in another modality. A thought captured in voice
doesn't surface in chat. A fact a user told their Discord-facing agent is
invisible to their CLI session.

[Musubi](https://github.com/ericmey/musubi) is designed to be the memory
plane that spans them. Its three-plane model (episodic / curated / concept)
plus artifact plane plus lifecycle engine plus presence-scoped thoughts
gives every modality a shared, durable, cross-referenced memory.

This plugin is the bridge: it makes OpenClaw agents first-class citizens of
a Musubi deployment.

## What the plugin is

`openclaw-musubi` is an **OpenClaw plugin** that talks to a **Musubi core**
over HTTP and Server-Sent Events. It does not ship a memory core. It does
not bundle an embedding model. It does not own storage. Everything
substantive runs on the Musubi side; this plugin is a thin, careful client
that exposes Musubi's value to OpenClaw agents through the plugin SDK's
official extension points.

## Integration model: sidecar with authority

OpenClaw's plugin SDK offers two paths for memory integration:

1. **Exclusive memory capability** via `registerMemoryCapability` +
   `registerMemoryRuntime`. The plugin becomes *the* memory for OpenClaw
   agents. One active memory plugin per OpenClaw install.
2. **Additive supplements** via `registerMemoryCorpusSupplement` and
   `registerMemoryPromptSupplement`. The plugin contributes alongside
   whatever memory engine is active.

We take the additive path. This is **sidecar-with-authority**: OpenClaw's
native memory engine keeps running and owns the prompt-building latency
budget. Musubi contributes labeled results into the blended view, and the
model weighs authoritative sources (curated knowledge, synthesized concepts)
higher than raw chatter based on provenance labels in the prompt.

The full reasoning for choosing this model lives in
[`ADR-0001: Sidecar with authority`](../decisions/0001-sidecar-with-authority.md).

## Capabilities

Five pieces, layered so each is independently useful and each raises the
ceiling of what the previous can do:

### 1. Memory corpus supplement

Reads Musubi's curated and concept planes as a secondary corpus during
OpenClaw memory searches. Results come back with plane labels (`curated`,
`concept`), scores, and namespace provenance. OpenClaw's ranker blends them
with native results.

### 2. Memory prompt supplement

Injects a labeled section into the memory prompt: "Curated knowledge from
Musubi (high provenance): …". The labeling is the authority mechanism — the
model already knows to weigh curated facts above raw episodic mentions when
they disagree.

### 3. Capture mirroring

Hooks OpenClaw's memory-write events and mirrors each capture into Musubi's
episodic plane. This is the flywheel: every OpenClaw modality feeds the
shared memory automatically, without agents needing to remember to call a
tool.

### 4. Recall / remember / think tools

Three tools for explicit deep-path work:

- `musubi_recall` — hybrid retrieve across all planes with full score + rerank.
  Slower than the supplement but richer; agents call it when the supplement
  misses or when they need artifacts.
- `musubi_remember` — explicit episodic capture with importance + topics.
  Lets agents pin something as "this matters" beyond the default mirror.
- `musubi_think` — send a thought to another presence. "Tell my Claude Code
  session that the deploy is done."

### 5. SSE thought consumer

Subscribes to `/thoughts/stream` for the configured presence. Inbound
thoughts from other presences surface in the agent's next turn as context,
not as polling-delayed updates. When the stream drops, the client
reconnects with exponential backoff and replays via `Last-Event-ID`.

## Non-goals

- **Replace OpenClaw's native memory.** We're additive; users keep their
  `memory-lancedb` or similar. If Musubi becomes so load-bearing that the
  native engine adds no value, a future plugin (or a mode flip in this one)
  could go exclusive. Today we stay sidecar.
- **Run a Musubi core ourselves.** This plugin does not embed, chunk, or
  store. Everything meaningful is a Musubi API call.
- **Support arbitrary memory backends.** The plugin talks to Musubi's HTTP
  API specifically. Other backends should build their own plugins.
- **Own UI/UX beyond config + status.** Memory inspection, curated editing,
  and concept promotion live in Musubi (and its Obsidian-vault store of
  record).

## Where the design lives

- This file: what and why at the project level.
- [`presence-model.md`](./presence-model.md) — how agent identity maps to
  Musubi namespaces + scoped tokens.
- [`transport.md`](./transport.md) — HTTP + SSE behavior, retries,
  reconnect, dedup.
- [`../api-contract.md`](../api-contract.md) — the client-side expectations
  that mirror the Musubi canonical-api consumer contract.
- [`../decisions/`](../decisions/) — ADRs for every load-bearing choice.
