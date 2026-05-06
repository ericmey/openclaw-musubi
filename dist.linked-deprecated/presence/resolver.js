import { PresenceResolutionError } from "./errors.js";
const ENV_VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
export function resolvePresence(config, options = {}) {
    const { core, presence } = config;
    const { agentId, strict = false, env = process.env } = options;
    const mappedPresence = agentId && presence.perAgent ? presence.perAgent[agentId] : undefined;
    const resolvedPresence = mappedPresence ?? presence.defaultId;
    if (!resolvedPresence.includes("/")) {
        throw new PresenceResolutionError(`Invalid presence "${resolvedPresence}": expected "<owner>/<presence-id>"`, "invalid-presence", agentId);
    }
    const perAgentTokens = core.perAgentTokens;
    const mappedToken = agentId && perAgentTokens ? perAgentTokens[agentId] : undefined;
    if (strict &&
        agentId !== undefined &&
        presence.perAgent?.[agentId] !== undefined &&
        mappedToken === undefined) {
        throw new PresenceResolutionError(`Strict mode: agent "${agentId}" has a presence mapping but no entry in core.perAgentTokens. ` +
            `Add a token for "${agentId}" or disable strict mode.`, "strict-mode-mismatch", agentId);
    }
    const rawToken = mappedToken ?? core.token;
    const resolvedToken = applyEnvSubstitution(rawToken, env);
    if (!resolvedToken) {
        throw new PresenceResolutionError(agentId
            ? `No token resolved for agent "${agentId}".`
            : "No token resolved for default presence.", "missing-token", agentId);
    }
    const owner = resolvedPresence.split("/", 1)[0];
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
function applyEnvSubstitution(raw, env) {
    return raw.replace(ENV_VAR_PATTERN, (match, name) => {
        const value = env[name];
        return value ?? match;
    });
}
//# sourceMappingURL=resolver.js.map