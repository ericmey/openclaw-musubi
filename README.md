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
- Node.js `>= 24.16.0 < 25` or `>= 26.1.0` (the package's `engines.node` range)
- A reachable Musubi core with canonical episodic and retrieval APIs

## Install

On a host with OpenClaw and a reachable Musubi core, install the published
package:

```bash
openclaw plugins install npm:openclaw-musubi
```

OpenClaw may ask you to review and accept this third-party plugin and its
capabilities. Check the installed version before relying on a feature described
in this repository: the npm release can lag the source tree. To inspect the
published version, run `npm view openclaw-musubi version`.

The plugin takes OpenClaw's exclusive memory slot. Set
`plugins.slots.memory` and the plugin entry as shown below, then reload or
restart OpenClaw and run `openclaw musubi-status`. A successful install alone
does not prove that the Musubi core is reachable or that a token has the right
namespace scope.

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
        "hooks": { "allowConversationAccess": true },
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
          "capture": {
            "completedTurns": true,
            "skipSessionKeys": ["agent:*:ops-*"]
          }
        }
      }
    }
  }
}
```

Completed-turn capture uses the `agent_end` hook. OpenClaw registers that
hook only when this entry sets `hooks.allowConversationAccess` to `true`;
without it, the plugin can load while capturing no completed turns. This
grants the hook access to conversation content, so enable it only when you
intend to capture turns into Musubi.

After saving the configuration, reload or restart OpenClaw. Then inspect the
registered plugin and check its connection to Musubi:

```bash
openclaw plugins inspect musubi --runtime --json
openclaw musubi-status
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

## Upgrade notes

### From 1.x to 2.x

2.0.0 is a breaking change to the architecture (ADR-0004). On-disk delivery
state from a 1.x install is **not** safe to reuse as-is: the idempotency-key
prefix (`openclaw-mirror`) was kept for replay continuity with 1.0.x rows
that may already exist in a consumer outbox, but the delivery worker, the
capture shape, and the namespace mapping all changed.

If you are upgrading in place, plan for the new state directory under
`<stateDir>/musubi/delivery-outbox.sqlite` — starting it fresh is the
recommended path. If you must reuse the 1.x database, expect rows whose
content shape no longer matches the canonical `/v1/episodic` body to
dead-letter after their first retry; inspect with `openclaw musubi-status`
and prune deliberately.

## Documentation

- [Architecture overview](./docs/architecture/overview.md)
- [Runtime wiring](./docs/architecture/wiring.md)
- [Presence model](./docs/architecture/presence-model.md)
- [Transport and API contract](./docs/api-contract.md)
- [Architecture decisions](./docs/decisions/)

## License

MIT — see [LICENSE](./LICENSE).
