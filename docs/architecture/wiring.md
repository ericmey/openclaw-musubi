# Plugin wiring

How the subsystems that slices #2–#8 shipped get composed into a single
`definePluginEntry` registration, and how they shut down.

Entry point: [`src/index.ts`](../../src/index.ts) → delegates to
[`src/plugin/bootstrap.ts`](../../src/plugin/bootstrap.ts).

## Bootstrap sequence

`bootstrap(opts)` runs in five phases:

1. **Validate raw config** against `MusubiConfigSchema` (TypeBox). Fails
   loud on invalid input with a pointer to the offending path — plugins
   that load without memory would be a silent downgrade. `format: "uri"`
   is registered against `FormatRegistry` at module load so `core.baseUrl`
   constraints fire at validation time.
2. **Construct a shared `MusubiClient`** from `config.core`. Every
   subsystem gets the same instance so retry / idempotency / auth
   rotation live in one place.
3. **Build subsystems** from the shared client + config:
   - `corpusSupplement` — `MemoryCorpusSupplement.search/get`
   - `promptSupplement` — `MemoryPromptSectionBuilder`; synchronous
     `build()` reads from a cache that the scheduler warms
   - `captureMirror` — consumes `agent_end` events; swallows failures
     so OpenClaw's native memory write is never blocked
   - `recallTool` / `rememberTool` / `thinkTool` — agent-callable tools
4. **Register capabilities** via `OpenClawPluginApi`:
   - `registerMemoryCorpusSupplement(corpusSupplement)`
   - `registerMemoryPromptSupplement(builder)` — the builder is a
     plain function (`MemoryPromptSectionBuilder`), not the richer
     `PromptSupplement` object; the wiring adapts.
   - `registerTool(recall.definition)` / `remember` / `think`
   - `on("agent_end", handler)` — handler extracts the last message
     text into a `CaptureEvent` then calls `captureMirror.handleEvent`.
     Mirror is fire-and-forget relative to the hook.
5. **Start long-lived workers**:
   - **Prompt-refresh scheduler** (only if `supplement.enabled !== false`)
     — calls `promptSupplement.refresh()` once immediately, then on an
     interval (default 60s). Errors are logged via `api.logger.warn`;
     the interval keeps ticking. Re-entrance guard prevents overlapping
     refreshes on a slow Musubi.
   - **Thought-stream SSE consumer** (only if `thoughts.enabled !== false`)
     — enters its own reconnect loop (`createThoughtStream(...).start()`).
     The loop resolves only on `stop()`.

Return value: `LifecycleHandle { stop(), isStopped() }`.

## Registration order

The `bootstrap` integration test asserts this exact sequence so a
regression surfaces immediately:

```
registerMemoryCorpusSupplement
registerMemoryPromptSupplement
registerTool:musubi_recall
registerTool:musubi_remember
registerTool:musubi_think
on:agent_end
```

Supplements before tools → a config that disables supplements still
registers tools (they're independent). Hooks last → the plugin is fully
introspectable before any event can fire.

## Shutdown

`lifecycle.stop()` is idempotent and bi-phased:

1. **Scheduler.stop()** (synchronous). Clears the interval; any
   in-flight refresh completes but no new one starts.
2. **`await thoughtStream.stop()`**. Aborts the current fetch, clears
   the reconnect flag. The `AbortController` plus in-flight body drain
   settle on the microtask queue — hence the `await`.

Stopping the scheduler first means a slow refresh can't race against
the client teardown.

The plugin SDK's `definePluginEntry` signature doesn't expose an
`unload` hook (see `node_modules/openclaw/dist/plugin-sdk/src/plugin-sdk/plugin-entry.d.ts`)
so the host-side teardown path reaches the lifecycle via the
module-scope `getLifecycle()` export. When / if upstream grows a
`shutdown` hook, point it at `getLifecycle()?.stop()`.

## Error modes

- **Invalid config** → `register` rejects via `api.logger.error`; plugin
  is left inert. OpenClaw marks the plugin failed.
- **Network failure on first scheduler tick** → logged, interval keeps
  ticking; supplement cache stays empty until the next successful tick
  (the supplement returns an empty build-output in that state).
- **Musubi 401/403 on stream** → stream handler logs `auth error
  (status=N)`; reconnect loop honors 403 as terminal (see
  `src/thoughts/stream.ts`).
- **Capture mirror failure** → swallowed inside the mirror; OpenClaw's
  native memory write is unaffected (ADR-0001: sidecar with authority
  on its own plane, non-blocking on Musubi's).
