/**
 * Build retrieve targets for the Musubi cross-plane API.
 *
 * Per Musubi ADR 0031 (wildcard namespace segments) and ADR 0030
 * (agent-as-tenant), this plugin reads tenant-wide: a single 2-segment
 * `tenant/*` namespace with a `planes` list spans every channel the
 * agent has captured into. The server expands `*` against the live
 * Qdrant payload and merges results by score.
 *
 * Typical case (default supplement planes):
 *   - base "nyla/*"  → planes ["curated", "concept"]
 *
 * `nyla/*` subsumes the tenant's per-channel slots (`nyla/voice/*`,
 * `nyla/openclaw/*`) AND its `nyla/_shared/*` shared-knowledge slot —
 * one HTTP call covers them all. Each result row carries its concrete
 * stored namespace so callers can still tell *where* a memory came
 * from ("on our last call", "in the Openclaw thread").
 *
 * Writes still target the channel-tagged 3-segment slot from
 * `presence.namespaces.episodic`/etc — wildcards are read-only.
 */

import type { PresenceContext } from "../presence/resolver.js";

export type RetrieveTarget = {
  readonly baseNamespace: string;
  readonly planes: readonly string[];
};

/**
 * Build targets from a presence context and a filtered plane list.
 *
 * @param presence  Resolved presence context.
 * @param planes    Ordered list of planes to query (e.g. ["curated","concept"]).
 */
export function buildRetrieveTargets(
  presence: PresenceContext,
  planes: readonly string[],
): RetrieveTarget[] {
  // Derive the tenant from the resolved presence (`<owner>/<presence-id>`).
  // Resolver guarantees a `/` so this split always has a usable [0].
  const owner = presence.presence.split("/", 1)[0]!;
  const tenantWildcardBase = `${owner}/*`;

  return [{ baseNamespace: tenantWildcardBase, planes: [...planes] }];
}
