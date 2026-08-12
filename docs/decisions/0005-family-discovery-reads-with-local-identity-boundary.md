# ADR-0005: Family-discovery reads with a local identity boundary

- **Status:** Accepted
- **Date:** 2026-08-12
- **Deciders:** Eric, Yua (review contract), Aoi (boundary contract), Claude (implementation)

## Context

Reads previously sent an explicit wildcard namespace (`<owner>/*`) on
`/v1/retrieve`, a shape inherited from upstream Musubi ADR 0031. The server
expands explicit wildcards against live Qdrant payloads and runs them with
strict authorization: every expanded namespace must be within the token's
scope or the ENTIRE request is rejected with 403.

That coupling took production recall down: a single orphaned pre-migration
row (`rika/7ds/episodic`) 403'd every search rika made from 2026-08-07
onward, and the first family-level `shared/concept` write produced by
server-side synthesis would have done the same to all eight agents at once.
One stored namespace outside a token's scope — data the agent never asked
for — was sufficient to destroy that agent's recall entirely.

The server's AUTH-001 no-namespace path solves this: when the request omits
`namespace`, the server enumerates the caller's identity family and returns
the AUTHORIZED SUBSET, filtering unauthorized namespaces instead of
rejecting the request.

But the omission trades one failure mode for a worse one. With no namespace
in the request, the server derives the identity family solely from the
presented token. Under a credential misbinding — agent A configured with
agent B's token in `core.perAgentTokens` — the old explicit request failed
authorization (fail-closed, misbinding surfaced as a 403); the no-namespace
request succeeds and silently returns B's memories to A. Neither agent
would know. For a system whose entire premise is that each agent's memory
is *hers*, that is the worst available failure mode.

(Config path for the binding in question:
`plugins.entries.musubi.config.core.perAgentTokens` in `openclaw.json`.)

## Decision

Reads omit `namespace` and use the server's family-discovery path — AND the
plugin enforces a local identity boundary on every response:

1. `buildRetrieveTargets` carries `expectedOwner` — the first segment of
   the *configured* presence, the identity this client believes it is
   retrieving for.
2. On response, every row's first namespace segment is checked against
   `expectedOwner` BEFORE any downstream content handling — the row is
   never merged, surfaced, or logged. (The HTTP body is necessarily
   JSON-parsed by the client before the row loop runs; the guarantee is
   about what happens to row content after that, not about parsing.)
3. The FIRST foreign row fails the entire call with an identity-boundary
   error naming the foreign namespace (never its content). No partial
   success; no silent dropping of mismatched rows. The error directs
   operators to the exact token binding:
   `plugins.entries.musubi.config.core.perAgentTokens`.

The boundary is deliberately owner-level, not presence-level: cross-presence
reads within one family (`rika/shared/concept` alongside `rika/hw-7ds/*`)
are the intended product of family discovery. Cross-family reads are never
legitimate on this path.

## Alternatives considered

**Keep `<owner>/*` and have the server filter explicit wildcards too.**
Changes AUTH-001's strict-for-explicit contract for every client, and
explicit-strict is the correct default for callers that name a namespace.
The plugin is the one caller that wants discovery semantics; it should use
the discovery path.

**Validate the token's family server-side against a client-sent hint.**
A client that can send a hint can send a wrong one; the server cannot
distinguish a misbound client from a lying one. The client is the only
party that knows which identity it *intended*, so the check belongs there.

**Silently drop foreign rows and return the rest.** Hides the misbinding —
recall works well enough that nobody investigates, while the token
continues to authenticate as the wrong identity for writes, captures, and
every other surface. Partial success is the failure mode where "rika
receives hana's memories and neither of them knows" persists indefinitely.

## Consequences

- One misbound token turns every search by that agent into a loud,
  actionable error instead of a quiet cross-identity leak.
- A server bug that leaks foreign namespaces into family discovery is
  caught by the same check and fails the same way.
- The unused-`owner` lint smell from the interim no-namespace patch is
  resolved: the owner is now load-bearing as `expectedOwner`.
- Supersedes the plugin's use of upstream ADR 0031's wildcard-base
  retrieve shape (this document is the durable record of that
  supersession).
