/**
 * openclaw-musubi plugin entry point.
 *
 * Wires every subsystem (slices #2–#8) into a single
 * `definePluginEntry` registration:
 *
 *   - `MusubiClient` — typed HTTP client (#2)
 *   - Presence resolution (#3)
 *   - `MemoryCorpusSupplement` — agent-queried recall (#4)
 *   - `MemoryPromptSupplement` — passive prompt injection (#5)
 *   - Capture mirror via `agent_end` hook (#6)
 *   - Thought-stream SSE consumer (#7)
 *   - `musubi_recall` / `musubi_remember` / `musubi_think` tools (#8)
 *
 * All wiring, scheduling, and shutdown lives in `./plugin/bootstrap.ts`
 * + `./plugin/lifecycle.ts` so `definePluginEntry`'s `register` stays a
 * thin adapter and the wiring is unit-testable against a mock API.
 *
 * The plugin SDK's `register` signature is synchronous (returns `void`);
 * `bootstrap()` is async because config validation + first-tick scheduler
 * setup happen on the microtask queue. We fire-and-forget the promise and
 * surface failures through `api.logger.error`. The lifecycle handle is
 * kept at module scope so the process-exit teardown path can reach it —
 * see `docs/architecture/wiring.md` § Shutdown.
 */

import { definePluginEntry } from "./api.js";
import { bootstrap, type BootstrapPluginApi } from "./plugin/bootstrap.js";
import type { LifecycleHandle } from "./plugin/lifecycle.js";

let lifecycle: LifecycleHandle | undefined;

/** Exposed for tests + host-side teardown hooks. */
export function getLifecycle(): LifecycleHandle | undefined {
  return lifecycle;
}

export default definePluginEntry({
  id: "musubi",
  name: "Musubi Memory",
  description:
    "Connect OpenClaw agents to a Musubi memory core. Episodic capture mirroring, curated + concept recall via memory supplements, and presence-to-presence thought delivery over SSE.",
  register(api) {
    const rawConfig = (api as unknown as { config?: unknown }).config;
    void bootstrap({
      api: api as unknown as BootstrapPluginApi,
      rawConfig,
    })
      .then((handle) => {
        lifecycle = handle;
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        api.logger.error(`musubi: bootstrap failed; plugin is inert — ${message}`);
      });
  },
});
