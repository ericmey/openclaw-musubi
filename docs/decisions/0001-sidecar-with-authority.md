# ADR-0001: Sidecar-with-authority memory integration

- **Status:** Accepted
- **Date:** 2026-04-19
- **Deciders:** @ericmey, Aoi (OpenClaw), Aoi (Musubi)

## Context

OpenClaw agents need memory that spans modalities. The same named agent
may run in a CLI, in Discord, in LiveKit voice, in a browser — and today
each modality has its own short-term context plus an optional local
long-term memory plugin (e.g., `memory-lancedb`). None of those see each
other. A thought captured in voice doesn't show up in chat; a fact the
user told their Discord-facing agent is invisible to their CLI session.

[Musubi](https://github.com/ericmey/musubi) v2 is a production-grade
memory plane with three planes (episodic / curated / artifact), a bridge
concept plane, a lifecycle engine (maturation → synthesis → promotion),
hybrid retrieval (BGE-M3 + SPLADE++ + rerank), an Obsidian-vault
store-of-record for curated knowledge, and presence-scoped thoughts. It
is designed to be the memory that spans modalities.

The OpenClaw plugin SDK exposes four levels of integration for memory:

1. **Sidecar skill** — agents call Musubi tools explicitly; two
   disconnected memory systems run in parallel.
2. **Embedding-provider adapter** — `registerMemoryEmbeddingProvider`;
   Musubi becomes an embedding backend for OpenClaw's existing memory
   engine, but the *storage* and *lifecycle* stay OpenClaw-owned.
3. **Additive supplements** — `registerMemoryCorpusSupplement` and
   `registerMemoryPromptSupplement`; Musubi contributes into the blend
   without replacing the memory engine.
4. **Exclusive memory capability** — `registerMemoryCapability` +
   `registerMemoryRuntime`; Musubi *is* the memory for OpenClaw agents.
   One active memory plugin per OpenClaw install.

We need to pick one as the v0.1 posture. The decision affects latency
budgets, degraded-mode behavior, contract surface, and how much of
Musubi's value we can surface to agents.

## Decision

**We adopt Level 3 (additive supplements) for v0.1, in a configuration we
call "sidecar-with-authority."**

Musubi runs alongside OpenClaw's native memory engine. The plugin:

- Registers a **corpus supplement** that returns Musubi curated + concept
  results into OpenClaw's memory search, scored so authoritative sources
  naturally rank higher.
- Registers a **prompt supplement** that injects a labeled section
  ("Curated knowledge from Musubi (high provenance): …") so the model
  treats it with appropriate weight.
- Hooks OpenClaw's memory-write events to **mirror every capture** into
  Musubi's episodic plane, giving cross-modality continuity.
- Exposes explicit tools (`musubi_recall`, `musubi_remember`,
  `musubi_think`) for agent-triggered deep queries and cross-presence
  thoughts that the supplement cannot replace.

"Authority" here is **soft authority via labeled provenance**, not runtime
override. The plugin frames its contributions so the model weighs them
appropriately; OpenClaw's native memory engine remains the primary
prompt-building path.

## Alternatives considered

### Level 1 — Sidecar skill

Tempting because it is the simplest integration: just tools, no
supplements, no hooks. Rejected because it leaves 90 % of Musubi's value
unreachable. Agents only benefit when they remember to call the tools,
and most never do.

### Level 2 — Embedding-provider adapter

Tempting because it is a named SDK extension point designed for exactly
this shape of partnership. Rejected because Musubi is not primarily an
embedder — BGE-M3 and SPLADE++ happen *inside* Musubi, against its own
storage, inside its own lifecycle. Exposing it as an embedding adapter
for OpenClaw to use its own storage backend discards the three-plane
model, the lifecycle engine, the vault-of-record, and the
synthesis/promotion pipeline. That is almost the entire product.

### Level 4 — Exclusive memory capability

Tempting because it is where the value clearly lives at scale: one memory
across every modality, with full planes and lifecycle, no duplication.
Rejected for v0.1 because:

- It is an **exclusive slot**. Any user installing the plugin would have
  to migrate existing memory (or accept "everything before today is
  invisible"). Fine for a greenfield installation; hostile for everyone
  else.
- Prompt-building has a hard latency budget. Musubi's deep-retrieval path
  (hybrid + rerank) may exceed it. We would need to split: fast-path for
  prompt assembly, deep-path for explicit recall. That split is
  buildable, but unproven before we have real traffic.
- If Musubi is down, agents are memoryless. This is a worse failure mode
  than "Musubi-contributions temporarily absent."
- The runtime memory-capability contract surface is larger and less
  fully explored than the supplement contract; early mistakes cost more
  to correct.

Level 4 remains on the roadmap. ADR-0001 anticipates a follow-up ADR (and
possibly a flipped mode in this plugin) that promotes the integration
once Level 3 has proven out in lived use.

## Consequences

- The plugin ships useful value this quarter instead of next. Corpus
  supplement + prompt supplement + capture mirror + tools is meaningfully
  shippable against the existing Musubi v2 surface.
- OpenClaw's native memory engine remains primary. Users can disable the
  plugin without losing memory.
- Authority is persuasive, not enforced: the model can ignore a labeled
  curated fact if it reasons its way around it. Acceptable for v0.1;
  upstream Musubi's contradiction detection gives a hard-authority path
  if it proves insufficient.
- Dual-write is a live consideration: OpenClaw's native memory and
  Musubi episodic both capture the same events. The mirror hook is the
  cheapest way to resolve this today. If the two drift meaningfully, we
  revisit.
- Cross-modality continuity is **partial**, not total. Non-OpenClaw
  modalities (CLI chat outside OpenClaw, a voice agent that does not
  route through the mirror hook) will still live outside Musubi until
  their own adapters ship.

## References

- Upstream Musubi v2 architecture: `docs/architecture/01-overview/three-planes.md`
- OpenClaw SDK overview: `docs/plugins/sdk-overview.md`
- OpenClaw memory plugin pattern: `extensions/memory-lancedb/`
- ADR-0002 (SSE for thought delivery) — pairs with this decision.
- ADR-0003 (per-presence bearer tokens) — how the plugin handles identity
  across agents.
