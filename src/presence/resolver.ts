import type { MusubiConfig } from "../config.js";
import { PresenceResolutionError } from "./errors.js";

/**
 * Result of resolving a presence + token for a given operation.
 *
 * Every Musubi-bound call consumes a `PresenceContext` so identity routing
 * is uniform across the plugin. The namespace hints are conventional defaults
 * derived from `<owner>/<presence>` per docs/architecture/presence-model.md;
 * a future schema field could let operators override them.
 */
export type PresenceContext = {
  readonly presence: string;
  readonly token: string;
  readonly namespaces: {
    readonly episodic: string;
    readonly thought: string;
    readonly artifact: string;
    readonly curatedReadScope: readonly string[];
  };
};

export type ResolveOptions = {
  /**
   * The OpenClaw agent the operation is being performed on behalf of. When
   * absent, the resolver uses `presence.defaultId` and `core.token`.
   */
  readonly agentId?: string;

  /**
   * When true, an agent that has a presence mapping but no matching entry in
   * `core.perAgentTokens` is treated as a configuration error rather than
   * silently falling back to `core.token`. Use in deployments where each
   * agent's identity must be cryptographically isolated.
   */
  readonly strict?: boolean;
};

type PresenceConfig = Pick<MusubiConfig, "core" | "presence">;

export function resolvePresence(
  config: PresenceConfig,
  options: ResolveOptions = {},
): PresenceContext {
  const { core, presence } = config;
  const { agentId, strict = false } = options;

  const mappedPresence = agentId && presence.perAgent ? presence.perAgent[agentId] : undefined;
  const resolvedPresence = mappedPresence ?? presence.defaultId;

  if (!resolvedPresence.includes("/")) {
    throw new PresenceResolutionError(
      `Invalid presence "${resolvedPresence}": expected "<owner>/<presence-id>"`,
      "invalid-presence",
      agentId,
    );
  }

  const perAgentTokens = core.perAgentTokens;
  const mappedToken = agentId && perAgentTokens ? perAgentTokens[agentId] : undefined;

  if (
    strict &&
    agentId !== undefined &&
    presence.perAgent?.[agentId] !== undefined &&
    mappedToken === undefined
  ) {
    throw new PresenceResolutionError(
      `Strict mode: agent "${agentId}" has a presence mapping but no entry in core.perAgentTokens. ` +
        `Add a token for "${agentId}" or disable strict mode.`,
      "strict-mode-mismatch",
      agentId,
    );
  }

  // Tokens arrive already materialized. `${VAR}` interpolation used to happen
  // here, but registration hard-refuses any token string containing `${...}`
  // (plugin/bootstrap.ts § validateConfig) precisely because an unresolved
  // placeholder reaching the wire is the 401-shaped silent failure this
  // plugin exists to refuse — so the substitution could never run, and if it
  // had, a missing env var would have left the literal `${VAR}` as the bearer.
  // Secret resolution belongs to OpenClaw's SecretRef contract.
  const resolvedToken = mappedToken ?? core.token;

  if (!resolvedToken) {
    throw new PresenceResolutionError(
      agentId
        ? `No token resolved for agent "${agentId}".`
        : "No token resolved for default presence.",
      "missing-token",
      agentId,
    );
  }

  const owner = resolvedPresence.split("/", 1)[0];
  if (!owner) {
    throw new PresenceResolutionError(
      `Invalid presence "${resolvedPresence}": owner is empty`,
      "invalid-presence",
      agentId,
    );
  }

  return {
    presence: resolvedPresence,
    token: resolvedToken,
    namespaces: {
      episodic: `${resolvedPresence}/episodic`,
      thought: `${resolvedPresence}/thought`,
      artifact: `${resolvedPresence}/artifact`,
      curatedReadScope: [
        `${resolvedPresence}/curated`,
        `${owner}/_shared/curated`,
        `${owner}/_shared/concept`,
      ],
    },
  };
}
