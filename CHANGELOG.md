# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to a calendar-flavored semantic versioning scheme
(`YYYY.M.D-betaN` through the pre-1.0 period, standard semver after).

## [Unreleased]

### Added

- `MusubiClient` in `src/musubi/client.ts` — typed HTTP client over the
  Musubi canonical API. Bearer auth, fresh `X-Request-Id` per call,
  stable `Idempotency-Key` reused across retries on POST writes,
  per-request timeout via `AbortController`, exponential-backoff retry
  on network/5xx, `Retry-After` honored on 429, no retry on 4xx.
  `fetch` is injectable so tests run with zero new deps.
- `MusubiError` taxonomy in `src/musubi/errors.ts` — `NetworkError`,
  `TimeoutError`, `AuthError`, `NotFoundError`, `RateLimitError`,
  `ClientError`, `ServerError`. Discriminated by `code` and class.
- `RetryPolicy` + `nextDelayMs` in `src/musubi/retry.ts` —
  default `min(2^n * 500ms + rand(0, 250ms), 8s)` over up to 5 attempts;
  RNG injectable for deterministic tests.
- `resolvePresence(config, options)` in `src/presence/resolver.ts` returns
  a typed `PresenceContext` (presence, token, namespace hints) for any
  Musubi-bound operation. Honors shared mode, per-agent presence mapping,
  per-agent tokens with graceful fallback, strict mode, and `${ENV_VAR}`
  substitution. Typed `PresenceResolutionError` with `code` and `agentId`.
- `core.perAgentTokens` added to plugin config schema (both TypeBox and
  the manifest's JSON Schema) — maps agent ids to dedicated bearer tokens
  per ADR-0003.
- Schema parity test (`tests/schema-parity.test.ts`) that asserts
  `src/config.ts` (TypeBox) and `openclaw.plugin.json` (JSON Schema) agree
  on top-level keys, leaf types, enum members, and numeric bounds.
  Drift surfaces as a CI failure with a path-scoped error message.
- Initial repository scaffold: package manifest, TypeScript config, lint,
  test, and format tooling.
- Plugin manifest (`openclaw.plugin.json`) declaring config schema and UI
  hints for core URL, token, presence, supplement, capture, and thoughts.
- Architecture documentation: overview, presence model, transport (HTTP +
  SSE), API consumer contract.
- Architecture Decision Records:
  - ADR-0001 Sidecar-with-authority memory integration.
  - ADR-0002 Server-Sent Events for thought delivery.
  - ADR-0003 Per-presence bearer tokens.
- Contributor documentation: `README.md`, `CONTRIBUTING.md`,
  `CODE_OF_CONDUCT.md`, `SECURITY.md`.
- CI workflow, issue templates, PR template, CODEOWNERS.

[Unreleased]: https://github.com/ericmey/openclaw-musubi/commits/main
