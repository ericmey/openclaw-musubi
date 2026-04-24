# openclaw-musubi — Validated Issue Tracker

> Cross-validated against the Musubi core (`~/Projects/musubi`) on 2026-04-23.
> This document tracks every confirmed, corrected, or newly discovered issue.
> **Do not edit priority levels without a second review.**

---

## P0 — Critical (fix before any production use)

### 1. Per-agent tokens and `${ENV_VAR}` substitution are completely ignored by the HTTP client
**Files:** `src/plugin/bootstrap.ts:78-83`, `src/musubi/client.ts`

`bootstrap()` constructs **one shared `MusubiClient`** with the raw `config.core.token`.
`resolvePresence()` correctly resolves per-agent tokens and expands `${ENV_VAR}`
syntax, but the client has no per-request token override. In a multi-agent install,
every request sends `Authorization: Bearer <default-token>`. The server checks
scope via `resolve_namespace_scope()` in `auth/scopes.py`, so a default token
without per-agent scope will 403 on every per-agent operation.

**Fix:** Add a `token` override to `RequestOptions`, or make the client accept a
token-provider function.

---

### 2. Agent tools are created once with no `agentId`, and `execute()` cannot receive runtime agent context
**Files:** `src/plugin/bootstrap.ts:95-97`, `src/tools/recall.ts`, `src/tools/remember.ts`, `src/tools/think.ts`

All three tools are instantiated in `bootstrap()` with **no `agentId`**.
`execute(toolCallId, params)` has no hook for OpenClaw to inject the calling
agent's identity. Every tool call resolves to the **default presence**.

**Fix:** Accept agent context in `execute()`, or rebuild the tool registry per
agent if OpenClaw's SDK supports per-agent tool binding.

---

### 3. `agent_end` capture mirror drops `agentId` — every capture lands in the default presence
**Files:** `src/plugin/bootstrap.ts:136-142`, `src/plugin/bootstrap.ts:162-182`

`translateAgentEndEvent()` extracts `messages`, `runId`, and `sessionId` but
**never reads `agentId`**. Combined with issue #1, the capture mirror is
single-tenant even when `perAgent` is configured.

**Fix:** Extract `agentId` from the event and pass it through to `handleEvent()`.

---

### 4. `node_modules` is committed to the repository
**Location:** Root directory

The entire `node_modules/` directory (including `.pnpm/` store) is tracked in git.
This bloats the repo, makes diffs unreadable, and is a supply-chain audit liability.

**Fix:** `git rm -rf node_modules`, add a `.gitignore`, and ensure contributors
run `pnpm install`.

---

### 5. `thoughts.reconnect.maxBackoffMs` is schema-validated but never used
**Files:** `src/config.ts:52`, `src/plugin/bootstrap.ts`, `src/thoughts/stream.ts`

The user-configurable cap is **silently ignored** by `nextSseBackoffMs()`.
Additionally, the server returns `503` + `Retry-After: 5` when the SSE broker cap
is exceeded (`src/musubi/api/routers/thoughts.py:119-125`). The plugin maps 503 to
`http-error` and uses exponential backoff (1s, 2s, 4s...) instead of honoring
the server's 5-second hint.

**Fix:** Thread `config.thoughts.reconnect.maxBackoffMs` into `createThoughtStream`,
forward it to `nextSseBackoffMs()`, and honor `Retry-After` on 503.

---

### 6. Artifact plane is unqueryable even when explicitly requested
**Files:** `src/supplement/corpus.ts`, `src/supplement/prompt.ts`, `src/tools/recall.ts`

The "plane fanout" logic never adds `artifact` to the target list. In `recall.ts`,
if a caller passes `planes: ["artifact"]`, `selected` becomes empty. The comment
claims callers can opt in — but the code makes it impossible.

**Fix:** Add artifact namespace resolution to `presence.resolver.ts` and include
it in the fanout builders.

---

### 31. `CorpusSupplement.get()` uses wrong endpoints AND omits required `namespace` query param
**File:** `src/supplement/corpus.ts:118-135` *(net-new from Musubi cross-check)*

The server requires `?namespace=...` on every GET-by-id endpoint:

| Plane | Plugin calls | Server expects |
|-------|-------------|----------------|
| `curated` | `GET /v1/curated/{id}` | `GET /v1/curated-knowledge/{id}?namespace=...` |
| `episodic` | `GET /v1/episodic/{id}` | `GET /v1/memories/{id}?namespace=...` |
| `concept` | `GET /v1/concepts/{id}` | `GET /v1/concepts/{id}?namespace=...` |
| `artifact` | `GET /v1/artifacts/{id}` | `GET /v1/artifacts/{id}?namespace=...` |

**Two bugs:** wrong paths for curated and episodic, and missing `namespace`
query param on **all** planes. The server returns `422 Validation Error` for
every call.

**Fix:** Update paths and inject the resolved namespace into the query string.

---

### 32. `importance` minimum is 1 on the server, but plugin schemas and clamps allow 0
**Files:** `src/tools/parameters.ts`, `src/capture/translate.ts`, `src/tools/think.ts`

Server OpenAPI / Pydantic models specify:
- `CaptureRequest.importance`: `minimum: 1.0, maximum: 10.0, default: 5`
- `ThoughtSendRequest.importance`: `minimum: 1.0, maximum: 10.0, default: 5`

Plugin TypeBox schemas declare `minimum: 0` for `RememberParameters.importance`
and `ThinkParameters.importance`. `clampImportance()` returns `Math.max(0, ...)`.
A value of `0` passes client-side validation and receives `422` from Musubi.

**Fix:** Change all client-side minimums to `1` and update `clampImportance()`.

---

### 33. Client-side retrieve fanout is based on a false premise — server natively supports 2-segment cross-plane queries
**Files:** `src/supplement/corpus.ts`, `src/supplement/prompt.ts`, `src/tools/recall.ts`

The server (`src/musubi/api/routers/retrieve.py:55-110`) explicitly supports
**2-segment** (`tenant/presence`) namespaces with a `planes` array, expanding
each entry server-side and merging results by score.

The plugin's comments claim:
> "Canonical retrieve wants a 3-segment `tenant/presence/plane` namespace ...
> a single cross-plane call only ever returns hits from the plane in the
> request namespace."

This is **directly contradicted** by the server implementation. Consequences:
- **Inefficiency:** 3–4 HTTP requests instead of 1 for every recall / prompt-refresh / corpus-search.
- **Different failure semantics:** Server checks scope strictly per target for 2-segment queries — if ANY plane is out of scope, the **entire** request 403s (ADR 0028). The plugin's `Promise.allSettled` approach silently drops unauthorized planes.
- **Potential ranking drift:** Server-side merge uses a single sort; client-side merge sorts partial result sets.

**Fix:** Collapse retrieve calls to a single 2-segment request with `planes` array.
Document the changed failure semantics if the strict-403 behavior is unacceptable.

---

### 34. `api-contract.md` documents non-existent endpoints and fields
**File:** `docs/api-contract.md`

| Document claim | Server reality |
|----------------|----------------|
| `POST /v1/episodic` | Does not exist. Correct: `POST /v1/memories` |
| `POST /v1/episodic/batch` | Does not exist. Correct: `POST /v1/memories/batch` |
| Thought send idempotency via `client_id` in body | `ThoughtSendRequest` has **no** `client_id` field. Idempotency is header-only (`Idempotency-Key`). |
| `POST /v1/thoughts/read` mentioned as polling fallback | Exists, but plugin doesn't implement it. |

**Fix:** Rewrite `api-contract.md` to match `openapi.yaml` and canonical router code.

---

## P1 — High (functional gaps or config drift)

### 7. SSE stream ignores `503 Retry-After` from connection-cap overflow
**Confirmed and refined under issue #5 above.**

---

### 11. Prompt supplement refresh runs only for the default presence
**File:** `src/plugin/bootstrap.ts:127-132`

The scheduler calls `promptSupplement.refresh()` with no `agentId`. In multi-agent
setups, only the default presence's standing context is cached.

**Fix:** Schedule per-agent refreshes or accept that prompt supplements need
agent-scoped caching.

---

### 12. Only one thought stream is started — multi-agent thought delivery won't work
**File:** `src/plugin/bootstrap.ts:134-148`

One `ThoughtStream` with no `agentId`. If `perAgent` presences are configured,
thoughts addressed to those other presences are never received.

**Fix:** Spawn one stream per resolved unique presence when `perAgent` is configured.

---

### 13. `getLifecycle()` export has no consumer — plugin leaks on unload
**File:** `src/index.ts:26-28`

`getLifecycle()` returns the module-scoped handle, but there is **no teardown hook**
registered with OpenClaw. If the plugin is unloaded or the process exits, the SSE
stream and refresh interval keep running.

**Fix:** Wire `getLifecycle()?.stop()` into OpenClaw's unload hook, or document
that the host must call it.

---

### 14. `resolvePresence` env-var regex is overly restrictive
**File:** `src/presence/resolver.ts:29`

```ts
const ENV_VAR_PATTERN = /\$\{([A-Z_][A-Z0-9_]*)\}/g;
```

Rejects `${my_token}` or `${MusubiToken}`. Shell convention allows
`[A-Za-z_][A-Za-z0-9_]*`.

**Fix:** Allow `[A-Za-z_][A-Za-z0-9_]*` or align with shell conventions.

---

### 35. Live test setup documentation has a double `/v1` path bug
**File:** `tests/live/smoke.live.test.ts:15-16`

The test header says:
```bash
MUSUBI_LIVE_BASE_URL=http://musubi.mey.house:8100/v1
```

`MusubiClient` appends `/v1/memories` to `baseUrl`. Following the docs literally
produces `.../v1/v1/memories`. The `README.md` example correctly omits `/v1`, but
the live test comment contradicts it.

**Fix:** Remove `/v1` from the live test docstring.

---

### 36. `Last-Event-ID` replay is declared but **not implemented** on the server
**File:** `src/musubi/api/routers/thoughts.py:126-127` *(Musubi core)*

```python
"""Replay semantics via Last-Event-ID are declared in the spec but deferred to
the integration harness ... The header is accepted and validated but currently
the stream begins from the live broker queue only."""
```

The plugin correctly sends `Last-Event-ID` and persists it, but the server
**ignores it**. Thoughts received between disconnect and reconnect are **lost**
unless they happen to still be in the broker's in-memory queue.

**Fix:** Document this limitation prominently, or implement a polling fallback
to `/v1/thoughts/check` on reconnect to backfill the gap.

---

### 37. SSE stream (2-segment) vs thought-send (3-segment) scope mismatch is undocumented
**Files:** `src/musubi/api/routers/thoughts.py`, `src/musubi/api/routers/writes_thoughts.py`

- **Stream** (`GET /v1/thoughts/stream`) checks read scope on a **2-segment**
  namespace (e.g., `eric/openclaw`).
- **Send** (`POST /v1/thoughts/send`) checks write scope on a **3-segment**
  namespace (e.g., `eric/openclaw/thought`).

Musubi's scope matcher (`auth/scopes.py:_namespace_matches`) requires **exact
segment count match**. A token with scope `eric/openclaw/*:rw` matches
`eric/openclaw/thought` but **does NOT** match `eric/openclaw`. Therefore a
token must carry **both** a 2-segment read scope and a 3-segment write scope.

The plugin's ADR-0003 and `presence-model.md` do not document this dual-namespace
requirement. Operators will issue narrowly-scoped tokens that work for send but
403 on stream (or vice versa).

**Fix:** Document the dual-namespace scope requirement in ADR-0003 and the
config UI help text.

---

### 38. Server returns `202 Accepted` for captures, but plugin tests/docs expect `200 OK`
**File:** `src/musubi/api/routers/writes_episodic.py` (implied by OpenAPI)

The OpenAPI shows `202` for `POST /v1/memories`, `POST /v1/memories/batch`, and
`POST /v1/thoughts/send`. Plugin tests mock `status: 200`. `response.ok` covers
200–299, but the test suite validates against the wrong status code.

**Fix:** Update test expectations to `202`.

---

## P2 — Medium (maintainability / DRY)

### 15. `files` in `package.json` references missing `LICENSE` and `CHANGELOG.md`
**File:** `package.json:22-31`

`files` includes `LICENSE` and `CHANGELOG.md`, but neither exists in the repo.
`npm publish` will omit them.

**Fix:** Add the files or remove them from the `files` array.

---

### 16. Plane fanout logic is copy-pasted in three modules
**Files:** `src/supplement/corpus.ts:75-89`, `src/supplement/prompt.ts:87-101`, `src/tools/recall.ts:68-82`

The same `curatedReadScope` + episodic target-building code appears verbatim in
corpus, prompt, and recall. Any fix to plane resolution has to be made in three
places. Now also **unnecessary** (see issue #33).

**Fix:** Extract a `buildRetrieveTargets(presence, planes)` utility, or collapse
to 2-segment cross-plane calls.

---

### 17. `DEFAULT_REQUEST_TIMEOUT_MS` is duplicated
**Files:** `src/config.ts:32`, `src/musubi/client.ts:13`

Two sources of truth for the same default.

**Fix:** Import the constant from `config.ts` into `client.ts`.

---

### 18. `mergeRetryPolicy` is dead code
**File:** `src/musubi/retry.ts:43-45`

Exported and tested, but `MusubiClient` merges manually with
`{ ...DEFAULT_RETRY_POLICY, ...options.retry }`.

**Fix:** Use `mergeRetryPolicy()` in the client, or delete the export.

---

### 19. `src/runtime-api.ts` is empty and unused
**File:** `src/runtime-api.ts`

The file exports `{}` and is imported nowhere.

**Fix:** Delete it or populate it when a runtime need actually exists.

---

### 20. Missing linting / formatting config files
**Location:** Root directory

`package.json` declares `"lint": "eslint ."` and `"format": "prettier --write ."`,
but there are no `eslint.config.js` or `.prettierrc` files.

**Fix:** Add `eslint.config.js` and `.prettierrc`.

---

### 21. `verbatimModuleSyntax: false` in tsconfig
**File:** `tsconfig.json:18`

With `"type": "module"` and `NodeNext` resolution, enabling `verbatimModuleSyntax`
prevents accidental `import` of types without `type` modifiers.

**Fix:** Set `verbatimModuleSyntax: true`.

---

### 22. `PromptSupplement.build()` ignores `availableTools` and `citationsMode`
**File:** `src/supplement/prompt.ts:56`

The params are prefixed with `_` to suppress warnings, but the OpenClaw SDK passes
them for a reason. Ignoring `availableTools` means the supplement cannot tailor
content to the agent's current capabilities.

**Fix:** Either use the params or document why they are intentionally ignored.

---

### 23. `CorpusSupplement.get()` ignores `fromLine` and `lineCount`
**File:** `src/supplement/corpus.ts:118-135`

The params are destructured but never passed to the API or used in result shaping.
Also structurally broken (see issue #31).

**Fix:** Forward them to the fetch call or slice the returned content.

---

### 39. `title` is available in retrieve results but never surfaced
**File:** `src/musubi/api/routers/retrieve.py:139-148` *(Musubi core)*

The server puts `title` inside `RetrieveResultRow.extra.title`, not at the top
level. The plugin's `MusubiRetrieveRow` type has no `title` field, and
`toCorpusSearchResult` doesn't read `extra.title`. Titles from curated knowledge
are silently dropped.

**Fix:** Read `extra.title` in `toCorpusSearchResult` and expose it via the
`CorpusSearchResult.title` field.

---

### 40. Musubi upstream `openclaw-adapter.md` uses invalid `blended` plane
**File:** `~/Projects/musubi/docs/Musubi/07-interfaces/openclaw-adapter.md`

The Musubi repo's openclaw adapter doc (a different product — browser extension)
shows `namespace: "eric/_shared/blended"` and `planes: ["curated", "concept"]`.
`blended` is not in `_VALID_PLANES`. This is an upstream doc bug that could
mislead plugin authors.

**Fix:** Flag upstream; `blended` should be a 2-segment namespace with explicit
`planes` array.

---

## P3 — Low (edge cases / polish)

### 24. `baseUrl` format validator accepts dangerous schemes
**File:** `src/plugin/bootstrap.ts:43-51`

The `uri` format check uses `new URL(value)`, which accepts `javascript:alert(1)`
or `file:///etc/passwd`. The server mandates HTTPS in production.

**Fix:** Validate `value.startsWith("http://") || value.startsWith("https://")`.

---

### 25. `agent_end` hook handler is async cast to sync
**File:** `src/plugin/bootstrap.ts:136-142`

The async IIFE is cast `as unknown as (...args: unknown[]) => unknown`. If
`translateAgentEndEvent` ever throws, it becomes an unhandled rejection because
OpenClaw's `api.on` won't await the returned promise.

**Fix:** Wrap in a named function that catches and logs synchronously, then fire
the async work inside.

---

### 26. SSE parser doesn't handle isolated `\r` line endings
**File:** `src/thoughts/stream.ts:289`

The spec allows `\r`, `\n`, or `\r\n`. The code uses `/\r?\n/`, missing lone `\r`.

**Fix:** Use `/\r\n?|\n/`.

---

### 27. `BoundedDedupSet` TTL entries linger until next access
**File:** `src/thoughts/dedup.ts`

Expired entries are only purged inside `has()` or `add()`. Bounded by `maxSize`,
so not a leak, just a hygiene issue.

**Fix:** Optional — add a periodic cleanup pass or accept the trade-off.

---

### 28. External abort signal listener is never removed on success
**File:** `src/musubi/client.ts:137-141`

`once: true` removes it after firing, but if the request succeeds, the listener
stays attached to the external signal. Minor leak if many requests share a
long-lived signal.

**Fix:** Remove the listener in a `finally` block or track it explicitly.

---

### 29. `package.json` `openclaw.extensions` references source, not build output
**File:** `package.json:54-56`

```json
"extensions": ["./src/index.ts"]
```

The `build` script compiles to `dist/`. If OpenClaw loads from `node_modules`,
it may expect the compiled `.js`.

**Fix:** Verify whether OpenClaw's plugin loader resolves TS directly; if not,
point to `./dist/index.js`.

---

### 30. `tests/.gitkeep` in a directory with real files
**Location:** `tests/.gitkeep`

Unnecessary; remove it.

---

## Quick-reference summary table

| # | Severity | Area | One-liner |
|---|----------|------|-----------|
| 1 | **P0** | Auth / Client | Shared client ignores per-agent tokens |
| 2 | **P0** | Tools | Tools created without agentId; execute() can't receive it |
| 3 | **P0** | Capture | agent_end drops agentId; all captures default |
| 4 | **P0** | Repo | node_modules committed |
| 5 | **P0** | SSE / Config | maxBackoffMs unused; ignores server Retry-After on 503 |
| 6 | **P0** | Retrieve | Artifact plane unreachable in fanout |
| 31 | **P0** | Corpus | get() uses wrong endpoints + missing namespace param |
| 32 | **P0** | Validation | importance min is 1 server-side; plugin allows 0 |
| 33 | **P0** | Retrieve | Client-side fanout unnecessary; server supports 2-seg cross-plane |
| 34 | **P0** | Docs | api-contract.md documents fictional endpoints |
| 7 | P1 | SSE | 503 Retry-After ignored (covered by #5) |
| 11 | P1 | Prompt | Refresh only for default presence |
| 12 | P1 | SSE | One stream; multi-agent thought delivery broken |
| 13 | P1 | Lifecycle | No unload hook; resources leak |
| 14 | P1 | Config | Env-var regex rejects common patterns |
| 35 | P1 | Tests | Live test docs cause double /v1 prefix |
| 36 | P1 | SSE / Server | Last-Event-ID replay not implemented server-side |
| 37 | P1 | Auth / Docs | 2-seg vs 3-seg scope mismatch undocumented |
| 38 | P2 | Tests | Expect 200; server returns 202 |
| 15 | P2 | Package | files[] references missing LICENSE / CHANGELOG |
| 16 | P2 | DRY | Plane fanout copy-pasted ×3 |
| 17 | P2 | Config | DEFAULT_REQUEST_TIMEOUT_MS duplicated |
| 18 | P2 | Dead code | mergeRetryPolicy unused |
| 19 | P2 | Dead code | runtime-api.ts empty |
| 20 | P2 | Tooling | No eslint / prettier configs |
| 21 | P2 | TSConfig | verbatimModuleSyntax: false |
| 22 | P2 | Prompt | build() ignores availableTools / citationsMode |
| 23 | P2 | Corpus | get() ignores fromLine / lineCount |
| 39 | P2 | Retrieve | title in extra.title never surfaced |
| 40 | P2 | Upstream | Musubi openclaw-adapter.md uses invalid blended plane |
| 24 | P3 | Validation | baseUrl accepts javascript: schemes |
| 25 | P3 | Hooks | agent_end async cast to sync |
| 26 | P3 | SSE parser | Doesn't handle lone \r |
| 27 | P3 | Dedup | TTL entries linger until accessed |
| 28 | P3 | Fetch | Abort signal listener leak on success |
| 29 | P3 | Package | openclaw.extensions points to .ts not .js |
| 30 | P3 | Repo | tests/.gitkeep unnecessary |
