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

  /**
   * Override for environment-variable lookup. Defaults to `process.env`. Tests
   * inject a deterministic map.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
};

type PresenceConfig = Pick<MusubiConfig, "core" | "presence">;

const ENV_VAR_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

export function resolvePresence(
  config: PresenceConfig,
  options: ResolveOptions = {},
): PresenceContext {
  const { core, presence } = config;
  const { agentId, strict = false, env = process.env } = options;

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

  const rawToken = mappedToken ?? core.token;
  const resolvedToken = applyEnvSubstitution(rawToken, env);

  if (!resolvedToken) {
    throw new PresenceResolutionError(
      agentId
        ? `No token resolved for agent "${agentId}".`
        : "No token resolved for default presence.",
      "missing-token",
      agentId,
    );
  }

  const owner = resolvedPresence.split("/", 1)[0]!;

  return {
    presence: resolvedPresence,
    token: resolvedToken,
    namespaces: {
      episodic: `${resolvedPresence}/episodic`,
      curatedReadScope: [
        `${resolvedPresence}/curated`,
        `${owner}/_shared/curated`,
        `${owner}/_shared/concept`,
      ],
    },
  };
}

function applyEnvSubstitution(
  raw: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  return raw.replace(ENV_VAR_PATTERN, (match, name: string) => {
    const value = env[name];
    return value ?? match;
  });
}
