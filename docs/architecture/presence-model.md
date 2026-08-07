# Presence model

> Current-state document. Re-run `npm test` and inspect `src/presence/resolver.ts`
> before changing deployment identity or token routing.

Musubi operations are presence-scoped. Presences use
`<owner>/<presence-id>`—for example `vesper/hw-7ds`—and child plane namespaces
are derived from that identity.

## Shared presence

One presence and one token may represent an entire OpenClaw installation:

```json
{
  "core": {
    "baseUrl": "https://musubi.example.internal",
    "token": { "source": "exec", "provider": "onepassword", "id": "musubi-default" }
  },
  "presence": { "defaultId": "owner/openclaw" }
}
```

This is appropriate only when all agents are intentionally allowed to share
one memory identity.

## Per-agent presence

Each OpenClaw agent may map to a distinct Musubi presence and SecretRef:

```json
{
  "core": {
    "baseUrl": "https://musubi.example.internal",
    "token": { "source": "exec", "provider": "onepassword", "id": "musubi-default" },
    "perAgentTokens": {
      "vesper": { "source": "exec", "provider": "onepassword", "id": "musubi-vesper" }
    }
  },
  "presence": {
    "defaultId": "owner/openclaw",
    "perAgent": { "vesper": "vesper/hw-7ds" }
  }
}
```

OpenClaw materializes the SecretRefs declared by the plugin manifest. Literal
`${...}` placeholders are invalid and registration refuses them.

For every operation the resolver chooses `presence.perAgent[agentId]` and
`core.perAgentTokens[agentId]` together. Completed-turn delivery uses strict
mode: if an agent has a presence mapping but no dedicated token, capture fails
loud rather than borrowing the default token.

## Namespace conventions

For `vesper/hw-7ds`, the provider derives:

```text
vesper/hw-7ds/episodic  completed turns and explicit memories
vesper/hw-7ds/thought   outbound thought namespace
vesper/hw-7ds/artifact  exact artifact scope
vesper/_shared/curated  shared curated read scope
vesper/_shared/concept  shared concept read scope
```

Semantic retrieval uses the owner wildcard (`vesper/*`) and relies on the
token's server-enforced read scope. The plugin does not infer authorization
from the configured string.

## Scope requirements

Each agent token needs write access to its child episodic namespace and read
access to the planes intended for recall. Outbound thought use additionally
needs the relevant thought-send scope. The Musubi server is authoritative:
`401` and `403` become visible, non-retryable failures.

The plugin neither registers presences nor claims online status. Presence is an
identity and authorization boundary, not a liveness record.
