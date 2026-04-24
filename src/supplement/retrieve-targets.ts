/**
 * Build retrieve targets for the Musubi 2-segment cross-plane API.
 *
 * The server accepts a 2-segment namespace (`tenant/presence`) plus a
 * `planes` array and expands each plane internally (`<namespace>/<plane>`),
 * merging results by score. This collapses N×M per-plane calls into
 * N calls where N is the number of unique base namespaces.
 *
 * Typical case (default supplement planes):
 *   - base "eric/openclaw"  → planes ["curated", "concept"]
 *   - base "eric/_shared"   → planes ["curated", "concept"]
 *
 * The shared base is derived from `curatedReadScope` entries whose
 * prefix differs from the primary presence.
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
  const primaryBase = presence.presence;

  const targets: RetrieveTarget[] = [
    { baseNamespace: primaryBase, planes: [...planes] },
  ];

  // Shared namespaces are full 3-segment paths like "eric/_shared/curated".
  // Extract unique bases (first two segments) and the planes they host.
  const sharedBases = new Map<string, Set<string>>();
  for (const ns of presence.namespaces.curatedReadScope) {
    const parts = ns.split("/");
    if (parts.length < 3) continue;
    const base = `${parts[0]}/${parts[1]}`;
    if (base === primaryBase) continue;
    const plane = parts[2];
    if (!planes.includes(plane)) continue;
    const set = sharedBases.get(base) ?? new Set<string>();
    set.add(plane);
    sharedBases.set(base, set);
  }

  for (const [baseNamespace, planeSet] of sharedBases) {
    targets.push({ baseNamespace, planes: [...planeSet] });
  }

  return targets;
}
