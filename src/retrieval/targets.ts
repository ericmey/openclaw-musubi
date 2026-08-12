/**
 * Build the family-wide target for Musubi cross-plane retrieval.
 *
 * Reads OMIT the `namespace` field entirely and send only an explicit
 * planes list. The server's AUTH-001 no-namespace path then enumerates
 * every concrete namespace in the caller's identity family and — unlike
 * an explicit namespace — FILTERS OUT unauthorized namespaces instead of
 * rejecting the whole request.
 *
 * This is deliberate. The previous shape (`<owner>/*`) was expanded
 * against live Qdrant payloads and ran with strict authorization: one
 * stored namespace outside the token's scope (a pre-migration orphan
 * row, a family-level `shared` concept namespace) made the server 403
 * the ENTIRE retrieve, taking the agent's recall down with it. The
 * no-namespace family path returns the authorized subset instead, so
 * recall degrades to "what this token can see" rather than failing.
 *
 * THE TRADE the omission makes — and the reason `expectedOwner` exists:
 * with no namespace in the request, the server derives the identity
 * family solely from the presented token. Under a credential
 * misbinding (agent A configured with agent B's token) the old explicit
 * `<owner>/*` request failed authorization; the no-namespace request
 * would succeed and return B-family memories to A. Callers MUST
 * therefore enforce the local identity boundary on the response: every
 * returned row's first namespace segment must equal `expectedOwner`,
 * and the first foreign row fails the whole call before any downstream
 * content handling — the row is never merged, surfaced, or logged.
 * See ADR-0005.
 *
 * Writes remain bound to concrete three-segment child namespaces.
 */

import type { PresenceContext } from "../presence/resolver.js";

export type RetrieveTarget = {
  /**
   * Namespace to send on the retrieve body, or undefined to use the
   * server-side family-discovery path (the default for reads).
   */
  readonly namespace: string | undefined;
  readonly planes: readonly string[];
  /**
   * First segment of the configured presence — the identity family this
   * client BELIEVES it is retrieving for. Response rows whose namespace
   * lies outside `${expectedOwner}/…` prove a token/presence misbinding
   * and must fail the call closed.
   */
  readonly expectedOwner: string;
};

export function buildRetrieveTargets(
  presence: PresenceContext,
  planes: readonly string[],
): RetrieveTarget[] {
  const owner = presence.presence.split("/", 1)[0];
  if (!owner) throw new Error(`invalid Musubi presence: ${presence.presence}`);
  return [{ namespace: undefined, planes: [...planes], expectedOwner: owner }];
}
