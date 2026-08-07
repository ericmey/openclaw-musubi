/**
 * Build the tenant-wide target for Musubi cross-plane retrieval.
 *
 * Reads use one two-segment `<owner>/*` namespace with an explicit planes
 * list. Writes remain bound to concrete three-segment child namespaces.
 */

import type { PresenceContext } from "../presence/resolver.js";

export type RetrieveTarget = {
  readonly baseNamespace: string;
  readonly planes: readonly string[];
};

export function buildRetrieveTargets(
  presence: PresenceContext,
  planes: readonly string[],
): RetrieveTarget[] {
  const owner = presence.presence.split("/", 1)[0];
  if (!owner) throw new Error(`invalid Musubi presence: ${presence.presence}`);
  return [{ baseNamespace: `${owner}/*`, planes: [...planes] }];
}
