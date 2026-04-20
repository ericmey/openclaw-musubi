# openclaw-musubi

**Musubi memory plane for OpenClaw agents.** Episodic capture, curated
knowledge recall, and presence-to-presence thought delivery — all routed
through a [Musubi](https://github.com/ericmey/musubi) core so your agents
share one memory across every modality they live in.

> Status: **early scaffold.** The repository structure, documentation, and
> plugin contract are being established first. Implementation slices follow.
> See [`docs/`](./docs) for the in-progress architecture.

## What it does

OpenClaw agents run in many places — CLI sessions, Discord, LiveKit voice,
browser extensions. Each modality has its own short-term memory, but nothing
knows what the others saw. Musubi is designed to be the shared memory plane
that spans them. `openclaw-musubi` is the plugin that plugs OpenClaw into it.

The plugin sits **sidecar** to OpenClaw's native memory engine — it does not
replace it. Instead it:

- **Mirrors** OpenClaw memory writes into Musubi's episodic plane so every
  capture lands in the cross-modality pool automatically.
- **Supplements** the memory prompt with Musubi's curated knowledge and
  synthesized concepts, labeled with provenance so the model weighs
  authoritative sources higher than raw episodic chatter.
- **Exposes tools** — `musubi_recall`, `musubi_remember`, `musubi_think` —
  for explicit deep-path queries and presence-to-presence communication.
- **Streams thoughts** inbound over Server-Sent Events so a thought sent by
  your Claude Code session surfaces in your Discord-facing agent within
  seconds, not polling-intervals.

This "sidecar-with-authority" model is a deliberate architectural choice
documented in [`docs/decisions/0001-sidecar-with-authority.md`](./docs/decisions/0001-sidecar-with-authority.md).

## Requirements

- **OpenClaw** `>= 2026.4.10`
- **Node.js** `>= 22`
- **pnpm** (recommended) or npm
- A reachable **Musubi core** (v2) with at minimum the HTTP API shipped.
  The `/thoughts/stream` SSE endpoint is required for real-time thought
  delivery; without it, thought support degrades gracefully to polling.

## Install

Not yet published — the package will be available on ClawHub and npm once
the first implementation slice lands.

```bash
# Future install command
openclaw plugins install openclaw-musubi
```

## Configure

A minimal configuration in your `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "musubi": {
        "config": {
          "core": {
            "baseUrl": "https://musubi.your-domain.internal",
            "token": "${MUSUBI_TOKEN}"
          },
          "presence": {
            "defaultId": "you/openclaw"
          }
        }
      }
    }
  }
}
```

See [`openclaw.plugin.json`](./openclaw.plugin.json) for the full config
schema, and [`docs/api-contract.md`](./docs/api-contract.md) for the
consumer-side behavior expected of any client (this plugin, but also
third-party reimplementations).

## Documentation

- [Architecture overview](./docs/architecture/overview.md)
- [Presence model](./docs/architecture/presence-model.md)
- [Transport: HTTP + SSE](./docs/architecture/transport.md)
- [API consumer contract](./docs/api-contract.md)
- [Architecture decisions](./docs/decisions/)

## Contributing

This is an OSS project built in the open. Read
[`CONTRIBUTING.md`](./CONTRIBUTING.md) for slice-based workflow, commit
conventions, and what makes a PR mergeable. Report security issues via the
process in [`SECURITY.md`](./SECURITY.md).

## License

MIT — see [`LICENSE`](./LICENSE).

## Related projects

- [Musubi](https://github.com/ericmey/musubi) — the memory core this plugin
  talks to.
- [OpenClaw](https://github.com/openclaw/openclaw) — the agent platform this
  plugin extends.
