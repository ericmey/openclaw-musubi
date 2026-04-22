# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to a calendar-flavored semantic versioning scheme
(`YYYY.M.D-betaN` through the pre-1.0 period, standard semver after).

## [Unreleased]

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
