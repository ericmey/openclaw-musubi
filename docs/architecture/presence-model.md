# Presence Model

Musubi is **presence-scoped** end-to-end. Every memory, every thought,
every retrieval query is tagged with the presence that produced or
requested it. Presences are strings shaped `<owner>/<presence-id>` — for
example, `eric/openclaw`, `eric/aoi`, `eric/claude-code`.

This document describes how OpenClaw agents map to Musubi presences and how
bearer tokens are scoped for that mapping.

## Mapping OpenClaw agents to Musubi presences

An OpenClaw installation may run many agents, each with distinct identity
and context. The plugin lets operators choose between two mapping styles.

### Shared-presence mode

One Musubi presence represents the entire OpenClaw install:

```json
{
  "presence": { "defaultId": "eric/openclaw" }
}
```

Every capture, supplement query, and thought uses that single presence.
Good for small setups with one or two agents and when cross-agent thought
routing is not required.

### Per-agent mode

Each OpenClaw agent maps to its own Musubi presence:

```json
{
  "presence": {
    "defaultId": "eric/openclaw",
    "perAgent": {
      "aoi": "eric/aoi",
      "rin": "eric/rin",
      "yua": "eric/yua"
    }
  }
}
```

When the plugin acts on behalf of an agent, it consults `perAgent[agentId]`
first, then falls back to `defaultId`. An agent missing from the map is not
an error — it uses the default.

Per-agent mode unlocks real presence-to-presence thoughts ("Aoi, tell Rin
to pick up the deploy") and per-agent namespaces in Musubi
(`eric/aoi/episodic` vs `eric/rin/episodic`).

## Token scoping

Musubi bearer tokens carry:

- A **presence** identity the token represents.
- A list of **scopes** — namespace read/write permissions and thought-check
  permissions.

### Shared-presence token

One token suffices. Scopes must cover:

- Read and write for the episodic namespace: `eric/openclaw/episodic`.
- Read for retrieval across planes the supplement queries: typically
  `eric/openclaw/curated`, `eric/openclaw/concept`, and any shared
  namespaces (`eric/_shared/curated`, `eric/_shared/concept`).
- `thoughts:check:openclaw` for the SSE subscription.
- `thoughts:send:*` if the plugin should relay outbound thoughts.

### Per-agent tokens

In per-agent mode, **each agent gets its own token**. This is not optional —
it is how Musubi enforces that `eric/aoi` cannot read `eric/rin`'s episodic
stream by accident or by a confused tool call.

Configuration for per-agent tokens will be added in a follow-up slice. The
near-term plan is a `perAgent` structure analogous to the presence map:

```json
{
  "presence": {
    "defaultId": "eric/openclaw",
    "perAgent": { "aoi": "eric/aoi" }
  },
  "core": {
    "baseUrl": "https://musubi.example.internal",
    "token": "${MUSUBI_TOKEN}",
    "perAgentTokens": {
      "aoi": "${MUSUBI_TOKEN_AOI}"
    }
  }
}
```

When `perAgentTokens[agentId]` exists, it is used. Otherwise `core.token`
is used — which should have broader scope for shared-presence mode, or be
absent in strict per-agent deployments.

## Namespace conventions

Musubi namespaces are hierarchical. A healthy deployment looks like:

```
eric/                         — owner
├─ openclaw/                  — the OpenClaw install as a presence
│  ├─ episodic                — captures from OpenClaw agents (shared mode)
│  ├─ curated                 — OpenClaw-authored curated notes (rare)
│  └─ artifact                — large saved pages, attachments
├─ aoi/                       — a specific agent
│  ├─ episodic
│  └─ curated
├─ rin/
│  └─ episodic
└─ _shared/
   ├─ curated                 — team/household knowledge
   ├─ concept                 — synthesized concepts (written by Musubi)
   └─ blended                 — a retrieval-time alias spanning the above
```

The plugin does not invent namespaces; operators configure them. Defaults
write episodic under the mapped presence's namespace and read curated from
the presence's own namespace plus `<owner>/_shared/curated` and
`<owner>/_shared/concept`.

## Presence registration

Musubi v2 does not require explicit presence registration — presences are
implicit in the tokens and namespaces in use. If a future slice surfaces a
"who is online right now" concept, the plugin will register the configured
presence(s) on load and deregister on shutdown. Today, appearing in an
`/episodic` capture or a `/thoughts/check` call is enough to count.
