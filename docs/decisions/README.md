# Architecture Decision Records

This folder holds [Architecture Decision Records](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions)
(ADRs) — short documents capturing one load-bearing decision each, written
at the time the decision is made, immutable afterward except for status
changes.

## Why ADRs

Code evolves; the reasons behind a design drift out of head-state and into
folklore. An ADR captures the reasoning so a contributor six months later
(or a fresh agent on a new session) can reconstruct **why** this code
looks the way it does, not just what it does.

## Format

Each ADR is a Markdown file named `NNNN-slug.md` where `NNNN` is
zero-padded. Start from [`template.md`](./template.md).

## Index

| ADR | Title | Status |
|---|---|---|
| [0001](./0001-sidecar-with-authority.md) | Sidecar-with-authority memory integration | Accepted |
| [0002](./0002-sse-for-thought-delivery.md) | Server-Sent Events for thought delivery | Accepted |
| [0003](./0003-presence-token-per-agent.md) | Per-presence bearer tokens | Accepted |

## When to write a new ADR

Write one when a decision:

- Is hard to reverse later.
- Forecloses a reasonable alternative.
- Involves a real tradeoff worth explaining.
- Will surprise a new contributor reading the code cold.

Do **not** write one for routine choices, file placement, or anything a
contributor can reconstruct by reading the diff.
