# ADR-0003: Per-presence bearer tokens

- **Status:** Accepted
- **Date:** 2026-04-19
- **Deciders:** @ericmey, Aoi (OpenClaw)

## Context

Musubi enforces access control at the namespace level via bearer tokens
that carry a presence identity and a scope list. A token issued for
`eric/aoi` can read and write `eric/aoi/episodic`, can read curated
namespaces it has been granted, and can subscribe to thoughts addressed
to its presence — and **nothing else**.

OpenClaw runs many agents. The plugin can structure identity in two
shapes:

1. **Shared presence.** One Musubi presence (`eric/openclaw`) represents
   the entire OpenClaw install. One bearer token covers everything every
   agent does.
2. **Per-agent presence.** Each OpenClaw agent maps to its own Musubi
   presence (`eric/aoi`, `eric/rin`, …). Each agent uses its own bearer
   token.

Both work. They have different security and operational properties.

## Decision

**The plugin supports both shapes; per-agent is the recommended posture
for any deployment with more than one agent.**

Configuration:

```json
{
  "presence": {
    "defaultId": "eric/openclaw",
    "perAgent": {
      "aoi": "eric/aoi",
      "rin": "eric/rin"
    }
  },
  "core": {
    "baseUrl": "https://musubi.example.internal",
    "token": "${MUSUBI_TOKEN}",
    "perAgentTokens": {
      "aoi": "${MUSUBI_TOKEN_AOI}",
      "rin": "${MUSUBI_TOKEN_RIN}"
    }
  }
}
```

Resolution order on each operation:

1. If the operation is on behalf of an agent and `perAgentTokens[agentId]`
   exists, use it (with `perAgent[agentId]` as the presence).
2. Otherwise, use `core.token` with `presence.defaultId`.

A token's scope list is enforced server-side; the plugin will not attempt
operations it knows are out-of-scope. It fails fast with a typed error
naming the missing scope.

## Alternatives considered

### Shared presence only

Tempting because it is operationally trivial: one token, one identity,
one set of scopes. Adopted as the default for single-agent installs.
Rejected as the only mode because:

- Cross-presence thoughts collapse to no-ops. "Aoi, tell Rin…" cannot be
  represented if Aoi and Rin are the same Musubi identity.
- A single token compromise grants the attacker the entire install's
  memory. Per-agent tokens limit blast radius.
- Per-agent namespaces in Musubi (`eric/aoi/episodic` vs
  `eric/rin/episodic`) lose their isolation if everything funnels through
  `eric/openclaw`.

### Per-agent only (no shared fallback)

Tempting because it is the cleanest security posture. Rejected because:

- Many real installs have a "system agent" or background tasks (capture
  mirroring, health checks) that don't fit neatly into a per-agent
  identity.
- Configuration becomes burdensome for trivial single-agent installs.
- A graceful fallback to a default presence is the kind of pragmatic
  affordance that makes a plugin pleasant to operate.

### Server-side derivation from a single root token

A future design could let Musubi mint per-presence sub-tokens on the fly
from a single root token. Tempting because it would simplify config.
Rejected for v1.0 because:

- No upstream support for sub-token minting today.
- Increases trust in the plugin handling the root token correctly.
- `${ENV_VAR}` substitution already gets us most of the operational
  benefit (tokens live in a secret manager, not in `openclaw.json`).

## Consequences

- Plugin code paths must always know **which agent** an operation is for.
  Operations triggered by an agent (capture, recall, think) carry agent
  identity through. Operations not triggered by an agent (background
  health probes) use the default presence + `core.token`.
- Misconfiguration (e.g., `perAgent` set but `perAgentTokens` missing)
  produces a clear startup error rather than silently using the default.
- Token rotation is per-presence, which matches the operational reality
  of secret managers — a leaked token for one agent does not require
  rotating tokens for every other agent.
- The plugin does not generate, validate, or refresh tokens. That is
  Musubi's responsibility and possibly an external auth system's. The
  plugin only consumes tokens supplied via config.

## References

- Upstream auth model: `src/musubi/auth/scopes.py` in the Musubi v2
  branch — defines `thoughts:check:<presence>` and namespace scope
  resolution.
- ADR-0001 (sidecar-with-authority) — informs why the plugin is the
  identity carrier rather than OpenClaw's native memory.
- ADR-0002 (SSE) — token scope governs which thought streams this plugin
  can subscribe to.
