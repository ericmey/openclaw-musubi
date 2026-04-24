/**
 * Plugin bootstrap — consumes the subsystems shipped in slices #2–#8
 * (musubi client, presence resolver, corpus + prompt supplements,
 * capture mirror, thought stream, agent tools) and wires them into a
 * single `definePluginEntry(...)` registration so OpenClaw can load
 * the plugin.
 *
 * Responsibilities (in order):
 *
 *   1. Validate the raw plugin config against the TypeBox schema; fail
 *      loud on invalid config so misconfigured plugins don't silently
 *      run without memory.
 *   2. Construct a single `MusubiClient` shared across all subsystems.
 *   3. Build the supplement builders, capture mirror, thought stream,
 *      and the three agent tools from the config + client.
 *   4. Register every capability with `OpenClawPluginApi`.
 *   5. Start the prompt-refresh interval + thought-stream SSE consumer
 *      and return a `LifecycleHandle` so OpenClaw can stop them on
 *      plugin unload.
 */

import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { createCaptureMirror } from "../capture/mirror.js";
import { MusubiConfigSchema, type MusubiConfig } from "../config.js";
import { MusubiClient } from "../musubi/client.js";
import type { FetchLike } from "../musubi/types.js";
import { createCorpusSupplement } from "../supplement/corpus.js";
import { createPromptSupplement } from "../supplement/prompt.js";
import { createThoughtStream, type ThoughtStream } from "../thoughts/stream.js";
import { createRecallTool } from "../tools/recall.js";
import { createRememberTool } from "../tools/remember.js";
import { createThinkTool } from "../tools/think.js";
import {
  createIntervalScheduler,
  createLifecycle,
  type LifecycleHandle,
  type Scheduler,
  type Stoppable,
} from "./lifecycle.js";

// Register `format: "uri"` once on module load. The plugin config
// declares `core.baseUrl` with `format: "uri"` (see `src/config.ts`),
// but TypeBox's format registry is empty by default — `Value.Check`
// against an unregistered format throws. A lightweight `new URL()`
// parse is exactly the shape validation we want.
if (!FormatRegistry.Has("uri")) {
  FormatRegistry.Set("uri", (value: string) => {
    try {
      void new URL(value);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * Structural subset of `OpenClawPluginApi` this plugin touches.
 *
 * Declared locally so tests can spy on a plain object without pulling
 * the full upstream type (and its transitive imports). The real
 * `OpenClawPluginApi` from `openclaw/plugin-sdk/plugin-entry` is a
 * superset of this. Mirrors the upstream `PluginLogger` surface —
 * string-only messages, no structured fields — so structured log
 * output is `stringify`-and-concat'd at the call site.
 */
export type BootstrapPluginApi = {
  readonly logger: {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
    debug?(message: string): void;
  };
  registerMemoryCorpusSupplement(supplement: unknown): void;
  registerMemoryPromptSupplement(builder: unknown): void;
  registerTool(tool: unknown, opts?: unknown): void;
  on(hookName: "agent_end", handler: (...args: unknown[]) => unknown): void;
};

export type BootstrapOptions = {
  readonly api: BootstrapPluginApi;
  readonly rawConfig: unknown;
  // Test-injection hooks. Production defaults live inside.
  readonly fetch?: FetchLike;
  readonly now?: () => Date;
  /** Override the scheduler factory (tests inject a fake to assert
   * start/stop without real timers). */
  readonly schedulerFactory?: (fn: () => Promise<void>, intervalMs: number) => Scheduler;
  /** Override the stream factory (tests inject a fake so no real SSE
   * reconnect loop spins up). */
  readonly thoughtStreamFactory?: (args: {
    config: MusubiConfig;
    fetch?: FetchLike;
  }) => ThoughtStream;
  /** Prompt-supplement refresh interval. Default 60s. */
  readonly refreshIntervalMs?: number;
};

const DEFAULT_REFRESH_INTERVAL_MS = 60_000;

export async function bootstrap(options: BootstrapOptions): Promise<LifecycleHandle> {
  const { api } = options;

  // 1. Validate config. `Value.Check` returns a boolean; `Value.Cast`
  //    would coerce silently which is the opposite of what we want —
  //    misconfigured plugins must fail loud so OpenClaw surfaces the
  //    install-time error to the operator.
  if (!Value.Check(MusubiConfigSchema, options.rawConfig)) {
    const errors = [...Value.Errors(MusubiConfigSchema, options.rawConfig)];
    const detail = errors.length > 0 ? errors[0] : undefined;
    const where = detail ? ` at ${detail.path || "<root>"}: ${detail.message}` : "";
    throw new Error(`musubi: invalid plugin config${where}`);
  }
  const config = options.rawConfig as MusubiConfig;

  // 2. Shared HTTP client. One instance across every subsystem so
  //    retry/idempotency budgets + auth rotation all live in one place.
  const client = new MusubiClient({
    baseUrl: config.core.baseUrl,
    token: config.core.token,
    requestTimeoutMs: config.core.requestTimeoutMs,
    fetch: options.fetch,
  });

  // 3. Build every subsystem from the shared client + config.
  const corpusSupplement = createCorpusSupplement({ client, config });
  const promptSupplement = createPromptSupplement({ client, config });
  const captureMirror = createCaptureMirror({
    client,
    config,
    logger: {
      warn: (msg, fields) => api.logger.warn(fields ? `${msg} ${JSON.stringify(fields)}` : msg),
      debug: api.logger.debug
        ? (msg, fields) => api.logger.debug!(fields ? `${msg} ${JSON.stringify(fields)}` : msg)
        : undefined,
    },
    now: options.now,
  });
  const recallTool = createRecallTool({ client, config });
  const rememberTool = createRememberTool({ client, config });
  const thinkTool = createThinkTool({ client, config });

  // 4. Register capabilities. Order matters only loosely (supplements
  //    before tools, hooks last) but we keep it stable for test #11.
  api.registerMemoryCorpusSupplement(corpusSupplement);
  const promptBuilder = (params: {
    availableTools: Set<string>;
    citationsMode?: string;
  }): string[] =>
    promptSupplement.build({
      availableTools: params.availableTools,
      citationsMode: params.citationsMode,
    });
  api.registerMemoryPromptSupplement(promptBuilder);
  api.registerTool(recallTool.definition);
  api.registerTool(rememberTool.definition);
  api.registerTool(thinkTool.definition);

  // `agent_end` → `capture-mirror.handleEvent`. Failures are swallowed
  // inside the mirror so a Musubi outage never blocks OpenClaw's own
  // memory write (ADR-0001).
  api.on("agent_end", (async (event: unknown, _ctx: unknown) => {
    const captureEvent = translateAgentEndEvent(event);
    if (captureEvent === undefined) return;
    await captureMirror.handleEvent(captureEvent);
  }) as unknown as (...args: unknown[]) => unknown);

  // 5. Start long-lived workers. `supplement.enabled !== false` →
  //    prompt-refresh loop; `thoughts.enabled !== false` → SSE consumer.
  const supplementEnabled = config.supplement?.enabled !== false;
  const thoughtsEnabled = config.thoughts?.enabled !== false;

  const schedulerFactory =
    options.schedulerFactory ??
    ((fn, intervalMs) =>
      createIntervalScheduler({
        fn,
        intervalMs,
        onError: (err) => {
          const message = err instanceof Error ? err.message : String(err);
          api.logger.warn(`musubi: prompt-supplement refresh failed — ${message}`);
        },
      }));

  let scheduler: Scheduler | undefined;
  if (supplementEnabled) {
    scheduler = schedulerFactory(
      () => promptSupplement.refresh(),
      options.refreshIntervalMs ?? DEFAULT_REFRESH_INTERVAL_MS,
    );
    scheduler.start();
  }

  let thoughtStream: Stoppable | undefined;
  if (thoughtsEnabled) {
    const streamFactory =
      options.thoughtStreamFactory ??
      ((args) => createThoughtStream({ config: args.config, fetch: args.fetch }));
    const stream = streamFactory({ config, fetch: options.fetch });
    // start() enters the reconnect loop; we don't await it (it blocks
    // while running and resolves only on stop()).
    void stream.start({
      onThought: () => {
        /* handler attachment is a future slice — today, the stream's
           presence is what matters. Observability-only subscribers can
           tail the stream without blocking the plugin load path. */
      },
      onAuthError: (status) =>
        api.logger.warn(`musubi: thought-stream auth error (status=${status})`),
    });
    thoughtStream = { stop: () => stream.stop() };
  }

  api.logger.info(
    `musubi plugin loaded (supplement=${supplementEnabled}, thoughts=${thoughtsEnabled}, base_url=${config.core.baseUrl})`,
  );

  return createLifecycle({ scheduler, thoughtStream });
}

/**
 * OpenClaw's `agent_end` event carries `messages: unknown[]`. The
 * capture-mirror expects a narrower `CaptureEvent` shape (id + content
 * minimum). This adapter extracts the last message text as the capture
 * content and synthesizes an id — sufficient for the wiring contract
 * test; a richer extraction is owned by a future slice if + when
 * OpenClaw exposes a canonical "capture-eligible" extraction helper.
 */
function translateAgentEndEvent(event: unknown):
  | {
      id: string;
      content: string;
      timestamp?: string;
      agentId?: string;
    }
  | undefined {
  if (!event || typeof event !== "object") return undefined;
  const e = event as {
    messages?: unknown[];
    runId?: unknown;
    sessionId?: unknown;
    agentId?: unknown;
  };
  if (!Array.isArray(e.messages) || e.messages.length === 0) return undefined;

  const last = e.messages[e.messages.length - 1];
  const content = extractMessageText(last);
  if (content === undefined || content.length === 0) return undefined;

  const id =
    (typeof e.runId === "string" && e.runId) ||
    (typeof e.sessionId === "string" && e.sessionId) ||
    `agent_end-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const agentId = typeof e.agentId === "string" ? e.agentId : undefined;
  return { id, content, agentId };
}

function extractMessageText(msg: unknown): string | undefined {
  if (!msg || typeof msg !== "object") return undefined;
  const m = msg as { content?: unknown; text?: unknown };
  if (typeof m.content === "string") return m.content;
  if (typeof m.text === "string") return m.text;
  return undefined;
}
