# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to a calendar-flavored semantic versioning scheme
(`YYYY.M.D-betaN` through the pre-1.0 period, standard semver after).

## [1.0.2](https://github.com/ericmey/openclaw-musubi/compare/v1.0.1...v1.0.2) (2026-05-06)


### Bug Fixes

* regenerate package lock ([27536be](https://github.com/ericmey/openclaw-musubi/commit/27536be15f844cf97e35a6901730c7993a45d388))

## [1.0.1](https://github.com/ericmey/openclaw-musubi/compare/v1.0.0...v1.0.1) (2026-05-06)


### Bug Fixes

* package.json main+exports and openclaw.extensions for npm consumers ([#34](https://github.com/ericmey/openclaw-musubi/issues/34)) ([25ea820](https://github.com/ericmey/openclaw-musubi/commit/25ea820e3634f14b4ce74f33dce025343c5ef334))

## [1.0.0](https://github.com/ericmey/openclaw-musubi/compare/v0.1.0...v1.0.0) (2026-05-05)


### ⚠ BREAKING CHANGES

* 1.0.0 stable. Plugin contract surface is now stable; future breaking changes follow semver. Consumers on Node <22.14 must upgrade. Consumers on openclaw <2026.5.4 must upgrade or stay on 0.1.x.

### Features

* prepare 1.0.0 stable release ([#31](https://github.com/ericmey/openclaw-musubi/issues/31)) ([05e7029](https://github.com/ericmey/openclaw-musubi/commit/05e7029d032ce619bbb113d69d2c34416d7658eb))
* **supplement:** tenant-wide retrieve via wildcard base ([#23](https://github.com/ericmey/openclaw-musubi/issues/23)) ([05424c3](https://github.com/ericmey/openclaw-musubi/commit/05424c36d2fac720c1152dd1c3b2f6d3b37a00c8))
* **thoughts:** history backfill on X-Musubi-Replay-Truncated ([#22](https://github.com/ericmey/openclaw-musubi/issues/22)) ([835b620](https://github.com/ericmey/openclaw-musubi/commit/835b6208a17386754636d272b42bcd001771d031))
* **tools:** canonical agent-tools conformance — musubi_search + musubi_recent ([#26](https://github.com/ericmey/openclaw-musubi/issues/26)) ([3f5b66e](https://github.com/ericmey/openclaw-musubi/commit/3f5b66e57e4cd64c5431daafbb61684a119731df))
* **tools:** musubi_get — fetch one object by id across any plane ([#24](https://github.com/ericmey/openclaw-musubi/issues/24)) ([8755542](https://github.com/ericmey/openclaw-musubi/commit/8755542468a058cfae94d9050230de91f05c9ae2))
* **v1.0:** align with Musubi v1.0 endpoint rename + title promotion ([#21](https://github.com/ericmey/openclaw-musubi/issues/21)) ([8077612](https://github.com/ericmey/openclaw-musubi/commit/80776126cfb7be54683e4f7c5c21f7a190965a64))


### Bug Fixes

* **bootstrap:** read api.pluginConfig instead of api.config ([dfc4b65](https://github.com/ericmey/openclaw-musubi/commit/dfc4b65df23803ce774395d71f066c51a12cce91))
* **plugin:** cross-validated remediation — per-agent tokens, 2-seg retrieve, SSE resilience, importance bounds ([#20](https://github.com/ericmey/openclaw-musubi/issues/20)) ([c2b49f2](https://github.com/ericmey/openclaw-musubi/commit/c2b49f26c8b1f19b745ca264f8392da75568b885))

## [Unreleased]

### Added
- **Stable 1.0.0 release.** Plugin contract surface, agent tool set, and configuration schema are now stable; future breaking changes will follow semver and be documented here.
- Released to npm as [`openclaw-musubi`](https://www.npmjs.com/package/openclaw-musubi) with provenance attestation (SLSA Level 3 via npm trusted publishing OIDC).
- Compat target lifted to OpenClaw `>=2026.5.4` — first version with the externalized-plugin gate path that recognizes our agent-tools registration when `contracts.tools` is properly declared.
- Six canonical agent tools now declared in `openclaw.plugin.json` `contracts.tools` — `musubi_search`, `musubi_recent`, `musubi_get`, `musubi_remember`, `musubi_think`, `musubi_recall` (deprecation alias). Each `registerTool` call now passes its name explicitly so the openclaw 5.4 registry can verify the registration against the contract.
- Repository tooling: Biome (lint + format), CodeQL workflow, Dependabot config, GitHub issue and PR templates as form-based YAML, expanded CI matrix covering Node 22 and 24, release-please for automated version PRs from conventional commits, OIDC trusted publishing.

### Changed
- Migrated from pnpm to npm. `engines.node` raised from `>=22` to `>=22.14.0` to match openclaw core.
- Migrated from ESLint + Prettier to Biome 2.4.14 with a single `biome.json` config.

## [0.1.0] — 2026-04-22

First tagged release. The plugin is loadable against OpenClaw via `definePluginEntry` and ships the full Musubi integration surface:

- **Episodic capture mirror** — `agent_end` events become `POST /v1/episodic` captures. Failures never block OpenClaw's native memory write.
- **Memory prompt supplement** — synchronous, cached `MemoryPromptSectionBuilder` with per-plane provenance labels. Background `refresh()` on a 60s interval.
- **Memory corpus supplement** — agent-queryable `search`/`get` against Musubi's canonical retrieve surface.
- **Thought-stream SSE consumer** — listens to `GET /v1/thoughts/stream` with all six consumer-expectation rules (jitter-backoff, persisted `Last-Event-ID`, bounded dedup, 403 no-reconnect, 60s ping-gap timeout, lex string object-id comparison).
- **Three agent tools** — `musubi_recall` (deep-path retrieve), `musubi_remember` (explicit capture at importance 7), `musubi_think` (presence-to-presence thought send).
- **Presence resolution** — maps OpenClaw agent ids to Musubi presences with per-agent token support.
- **Typed HTTP client** — retry, idempotency, error taxonomy, per-request timeout.

No runtime integration tests yet — the plugin is "built, not turned on." Load testing + a production cutover live behind the v0.x.y boundary; until then, v0.1.0 is an alpha suitable for sideload + exercise.

### Added

- `src/plugin/bootstrap.ts` — wires every subsystem (slices #2–#8) into a
  single `definePluginEntry` registration: validates the plugin config
  against the TypeBox schema (failing loud on invalid input), constructs
  a shared `MusubiClient`, builds the corpus + prompt supplements,
  capture mirror, three agent tools, and SSE thought stream, and starts
  the prompt-refresh scheduler + stream consumer. Returns a
  `LifecycleHandle` so the plugin teardown path can stop both long-lived
  workers deterministically. Test-injectable scheduler and stream
  factories keep bootstrap fully unit-testable without real timers.
- `src/plugin/lifecycle.ts` — small coordinator exposing
  `createLifecycle(...)` (idempotent `stop()` that tears down scheduler
  + stream in the right order) and `createIntervalScheduler(...)` (fire
  an immediate first tick, then poll on an interval with re-entrance
  guard and error isolation).
- `src/index.ts` now delegates to `bootstrap(...)` instead of logging a
  placeholder. First real plugin load. The lifecycle handle is kept at
  module scope + exposed via `getLifecycle()` for host-side teardown.
- `docs/architecture/wiring.md` — how the parts compose, scheduler
  cadence, shutdown order.
- `@sinclair/typebox` `FormatRegistry` is now primed at bootstrap time
  with a `uri` validator (thin `new URL(...)` parse) so the
  `core.baseUrl` schema constraint is enforced at install time instead
  of crashing `Value.Check` on an unregistered format.

### Added (earlier in this release window)

- Three agent-callable tools in `src/tools/`:
  - `createRecallTool(...)` → `musubi_recall` — deep-path retrieve across
    all planes with full hybrid + rerank.
  - `createRememberTool(...)` → `musubi_remember` — explicit episodic
    capture at importance 7 (above passive capture's 5), optional
    client-supplied idempotency key.
  - `createThinkTool(...)` → `musubi_think` — presence-to-presence
    thought send; recipient sees it in real-time via the SSE stream.
  Each factory returns `{ definition, recommendedOptional: true }` — the
  wiring slice passes `{ optional: true }` to `api.registerTool(...)`.
- TypeBox parameter schemas in `src/tools/parameters.ts`.
- `createThoughtStream({ config, ... })` in `src/thoughts/stream.ts` — SSE
  consumer for `GET /v1/thoughts/stream` with all six consumer-expectation
  rules: exponential backoff with jitter, persisted `Last-Event-ID`,
  bounded dedup set, 403 no-reconnect, 60s ping-gap timeout, lex string
  comparison for object ids. Zero-dep SSE frame parser. Injectable fetch,
  dedup, persistence, random, sleep, now — fully deterministic tests.
- `BoundedDedupSet` in `src/thoughts/dedup.ts` — max-size + TTL bounded
  `Map`-backed dedup with insertion-order eviction.
- `InMemoryLastEventIdStore` + `LastEventIdStore` interface in
  `src/thoughts/persistence.ts` — production consumers inject a
  runtime-backed implementation.
- `nextSseBackoffMs` in `src/thoughts/backoff.ts` — pure helper matching
  the spec formula: `min(2^n * 1000ms + rand(0, 1000ms), 60s)`.
- `createCaptureMirror({ client, config, logger })` in `src/capture/mirror.ts`
  exposes `handleEvent` / `handleBatch` for the wiring slice to register
  via OpenClaw's `agent_end` hook (the established pattern from
  `extensions/memory-lancedb`). Translates capture-eligible events into
  Musubi episodic posts (`/v1/episodic` and `/v1/episodic/batch`) with
  stable per-event idempotency keys (`openclaw-mirror:<id>`). **Failures
  are logged and swallowed** — never throws back into OpenClaw's caller.
- `translateCaptureEvent` + `deriveIdempotencyKey` in
  `src/capture/translate.ts` — pure functions; importance is clamped to
  `[0, 10]`, timestamp defaults to "now", per-presence namespace from the
  resolver.
- `createPromptSupplement({ client, config })` in `src/supplement/prompt.ts`
  returns an OpenClaw `MemoryPromptSectionBuilder`-shaped object plus an
  out-of-band `refresh()` method. Builder is **synchronous** (per OpenClaw
  contract) and reads from a pre-warmed cache; HTTP I/O lives in `refresh`.
  Stale cache survives transient core failures so prompts don't suddenly
  go empty mid-deploy. Per-plane labeled sections give the model the
  provenance signal it needs (curated > concept).
- `createCorpusSupplement({ client, config })` in `src/supplement/corpus.ts`
  returns an OpenClaw `MemoryCorpusSupplement`-shaped object. `search`
  POSTs `/v1/retrieve` in fast mode with configured planes (default
  `[curated, concept]`) and per-presence namespace; `get` fetches by
  `<plane>/<id>` lookup path. Failures swallowed → empty results so
  OpenClaw memory search never breaks. Provenance labels per plane
  let the model weigh curated > concept > episodic naturally.
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
