# openclaw-musubi

**First-class durable Musubi memory for OpenClaw agents.** The plugin owns
OpenClaw's exclusive memory slot and routes completed-turn capture, semantic
recall, exact-object reads, and deliberate stores through a Musubi core.

## Current architecture

`openclaw-musubi` declares `kind: "memory"` and must be selected with
`plugins.slots.memory = "musubi"`. It does not run beside `memory-core` as an
additive supplement. That earlier architecture is historical and was
superseded by [ADR-0004](./docs/decisions/0004-first-class-memory-provider.md).

The provider:

- registers the exclusive OpenClaw memory capability;
- exposes native `memory_search`, `memory_get`, and `memory_store` tools, plus
  the canonical Musubi tool surface;
- commits every completed turn to a local SQLite outbox before the
  `agent_end` hook returns;
- delivers with stable idempotency, receipt lookup, accepted/verified states,
  and canonical GET readback;
- retains retryable and permanently blocked deliveries for operator action;
- exposes delivery truth through `/musubi-status`, `musubi.status`, and the
  `openclaw musubi-status` CLI command.

Outbound `musubi_think` remains available. The former inbound SSE thought
subscriber is deliberately not registered: it had no OpenClaw context-delivery
contract and consuming a thought into an empty handler would be data loss
disguised as delivery.

## Requirements

- OpenClaw `>= 2026.7.1`
- Node.js `>= 22.22.3`
- A reachable Musubi core with canonical episodic and retrieval APIs

## Configuration

Musubi secret fields are declared OpenClaw `secretInputs`; use the same
structured SecretRef form as other native OpenClaw secrets. Literal `${...}`
placeholders are rejected locally before the provider registers.

```json
{
  "plugins": {
    "slots": { "memory": "musubi" },
    "entries": {
      "musubi": {
        "enabled": true,
        "config": {
          "core": {
            "baseUrl": "https://musubi.example.internal",
            "token": {
              "source": "exec",
              "provider": "onepassword",
              "id": "musubi-default"
            },
            "perAgentTokens": {
              "vesper": {
                "source": "exec",
                "provider": "onepassword",
                "id": "musubi-vesper"
              }
            }
          },
          "presence": {
            "defaultId": "owner/openclaw",
            "perAgent": { "vesper": "vesper/openclaw" }
          },
          "capture": { "completedTurns": true }
        }
      }
    }
  }
}
```

## Verify the live contract

These commands re-establish the claims above; the dates in documentation do
not substitute for running them:

```bash
npm run typecheck
npm run lint
npm test
npm run build
openclaw plugins inspect musubi --runtime --json
openclaw musubi-status
openclaw musubi-doctor --agent vesper
```

The loader-backed test runs a built artifact through OpenClaw 2026.7.1 with
`plugins.slots.memory = "musubi"`; it fails if manifest kind, runtime kind, or
exclusive capability ownership drift apart.

`musubi-doctor` is an explicit deep proof: it queues a diagnostic through the
same SQLite delivery path as a real turn, waits for canonical GET verification,
requires semantic retrieval to return that exact object, then soft-archives the
probe. It never runs automatically.

## Documentation

- [Architecture overview](./docs/architecture/overview.md)
- [Runtime wiring](./docs/architecture/wiring.md)
- [Presence model](./docs/architecture/presence-model.md)
- [Transport and API contract](./docs/api-contract.md)
- [Architecture decisions](./docs/decisions/)

## License

MIT — see [LICENSE](./LICENSE).
