import { createHash } from "node:crypto";
import { join } from "node:path";

import { FormatRegistry } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

import { getGlobalPluginRegistry, type OpenClawPluginApi } from "../api.js";
import {
  type CaptureDiagnostics,
  type CaptureDiagnosticsSnapshot,
  type CaptureSkipReason,
  getProcessCaptureDiagnostics,
} from "../capture/diagnostics.js";
import type { CaptureEvent } from "../capture/translate.js";
import { type MusubiConfig, MusubiConfigSchema } from "../config.js";
import { DeliveryController } from "../delivery/controller.js";
import { formatDoctor, runDeepDoctor } from "../doctor.js";
import { MusubiClient } from "../musubi/client.js";
import type { FetchLike } from "../musubi/types.js";
import { createGetTool } from "../tools/get.js";
import { createRecallTool } from "../tools/recall.js";
import { createRecentTool } from "../tools/recent.js";
import { createRememberTool } from "../tools/remember.js";
import { createSearchTool } from "../tools/search.js";
import { createThinkTool } from "../tools/think.js";

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

export type RegisterOptions = {
  readonly api: OpenClawPluginApi;
  readonly rawConfig: unknown;
  readonly fetch?: FetchLike;
};

export type RegisteredMusubi = {
  readonly config: MusubiConfig;
  readonly delivery: DeliveryController;
  readonly captureDiagnostics: CaptureDiagnostics;
};

export type AgentEndTranslation =
  | { readonly ok: true; readonly capture: CaptureEvent }
  | { readonly ok: false; readonly reason: Exclude<CaptureSkipReason, "capture_disabled"> };

/**
 * Register the first-class Musubi memory provider synchronously. Validation
 * happens before any capability is advertised so loader diagnostics cannot
 * report a configured provider whose credentials are still placeholders.
 */
export function registerMusubi(options: RegisterOptions): RegisteredMusubi {
  const { api } = options;
  const config = validateConfig(options.rawConfig);
  warnDeprecatedConfig(api, config);
  const client = new MusubiClient({
    baseUrl: config.core.baseUrl,
    token: config.core.token,
    requestTimeoutMs: config.core.requestTimeoutMs,
    fetch: options.fetch,
  });
  const delivery = new DeliveryController({ client, config, logger: api.logger });
  const captureDiagnostics = getProcessCaptureDiagnostics();

  api.registerMemoryCapability({
    // Musubi captures every completed turn durably at agent_end, so it does not
    // use OpenClaw's file-oriented pre-compaction flush plan. The provider's
    // prompt contract is tool guidance, not a global cache that could leak one
    // agent's presence into another agent's prompt.
    promptBuilder: ({ availableTools }) => buildMemoryPrompt(availableTools),
  });

  registerTools(api, client, config, delivery);

  api.on("agent_end", async (event: unknown, ctx: { agentId?: string }) => {
    captureDiagnostics.observe();
    const captureEnabled =
      config.capture?.completedTurns ?? config.capture?.mirrorOpenClawMemory ?? true;
    if (!captureEnabled) {
      captureDiagnostics.skip("capture_disabled");
      logCaptureDiagnostic(api, captureDiagnostics, "capture_disabled");
      return;
    }
    const translated = translateAgentEndEventWithReason(event, ctx.agentId);
    if (!translated.ok) {
      captureDiagnostics.skip(translated.reason);
      logCaptureDiagnostic(api, captureDiagnostics, translated.reason);
      return;
    }
    captureDiagnostics.translated();
    try {
      delivery.enqueueCapture(translated.capture);
      captureDiagnostics.enqueued();
      logCaptureDiagnostic(api, captureDiagnostics, "enqueued");
    } catch (error) {
      captureDiagnostics.enqueueFailed();
      // A local enqueue failure is not allowed to break the user turn, but it
      // is loud and operator-visible. It is never described as captured.
      api.logger.error(`musubi: agent_end capture was not queued — ${errorMessage(error)}`);
      logCaptureDiagnostic(api, captureDiagnostics, "enqueue_failed");
    }
  });

  api.registerService({
    id: "musubi-memory",
    start: async (ctx) => {
      await delivery.start(join(ctx.stateDir, "musubi", "delivery-outbox.sqlite"));
      captureDiagnostics.reset();
      api.logger.info(
        `musubi first-class memory provider started (base_url=${config.core.baseUrl})`,
      );
      logCaptureDiagnostic(api, captureDiagnostics, "service_started");
    },
    stop: async () => {
      await delivery.stop();
    },
  });

  api.registerGatewayMethod(
    "musubi.status",
    ({ respond }) =>
      respond(true, {
        provider: "musubi",
        ...delivery.status(),
        capture: captureStatus(captureDiagnostics),
      }),
    { scope: "operator.read" },
  );
  api.registerCommand({
    name: "musubi-status",
    description: "Show Musubi memory delivery health.",
    handler: async () => ({
      text: formatStatus(delivery.status(), captureStatus(captureDiagnostics)),
    }),
  });
  api.registerCommand({
    name: "musubi-doctor",
    description: "Run a deep write, readback, retrieval, and cleanup proof for Musubi memory.",
    requireAuth: true,
    handler: async (ctx) => ({
      text: formatDoctor(await runDeepDoctor({ client, config, delivery, agentId: ctx.agentId })),
    }),
  });
  api.registerCli(
    ({ program }) => {
      program
        .command("musubi-status")
        .description("Show Musubi memory delivery health")
        .action(() => {
          process.stdout.write(
            `${JSON.stringify({
              provider: "musubi",
              ...delivery.status(),
              capture: captureStatus(captureDiagnostics),
            })}\n`,
          );
        });
      program
        .command("musubi-doctor")
        .description("Run a deep Musubi provider proof")
        .option("--agent <id>", "OpenClaw agent identity to prove")
        .action(async (cliOptions: { agent?: string }) => {
          const result = await runDeepDoctor({
            client,
            config,
            delivery,
            agentId: cliOptions.agent,
          });
          process.stdout.write(`${JSON.stringify(result)}\n`);
          if (!result.ok) process.exitCode = 1;
        });
    },
    {
      commands: ["musubi-status", "musubi-doctor"],
      descriptors: [
        {
          name: "musubi-status",
          description: "Show Musubi memory delivery health",
          hasSubcommands: false,
        },
        {
          name: "musubi-doctor",
          description: "Run a deep Musubi provider proof",
          hasSubcommands: false,
        },
      ],
    },
  );

  return { config, delivery, captureDiagnostics };
}

function warnDeprecatedConfig(api: OpenClawPluginApi, config: MusubiConfig): void {
  if (config.supplement) {
    api.logger.warn(
      "musubi: config.supplement is deprecated and ignored by the first-class provider",
    );
  }
  if (config.thoughts) {
    api.logger.warn(
      "musubi: config.thoughts is deprecated; inbound thought delivery is not shipped",
    );
  }
  if (config.capture?.mirrorOpenClawMemory !== undefined) {
    api.logger.warn(
      "musubi: capture.mirrorOpenClawMemory is deprecated; use capture.completedTurns",
    );
  }
}

function validateConfig(rawConfig: unknown): MusubiConfig {
  if (!Value.Check(MusubiConfigSchema, rawConfig)) {
    const detail = [...Value.Errors(MusubiConfigSchema, rawConfig)][0];
    const where = detail ? ` at ${detail.path || "<root>"}: ${detail.message}` : "";
    throw new Error(`musubi: invalid plugin config${where}`);
  }
  const config = rawConfig as MusubiConfig;
  const secrets = [config.core.token, ...Object.values(config.core.perAgentTokens ?? {})];
  if (secrets.some((value) => /\$\{[^}]+\}/u.test(value))) {
    throw new Error(
      "musubi: unresolved secret placeholder in core token configuration; refusing to load",
    );
  }
  return config;
}

function buildMemoryPrompt(availableTools: Set<string>): string[] {
  const search = availableTools.has("memory_search") ? "memory_search" : "musubi_search";
  const get = availableTools.has("memory_get") ? "memory_get" : "musubi_get";
  const store = availableTools.has("memory_store") ? "memory_store" : "musubi_remember";
  return [
    "## Musubi memory",
    `Use ${search} when prior events, decisions, preferences, or relationships may matter. Search results are semantically related candidates, not proof that a specific event happened. Before making an episodic claim, require the returned evidence to directly support who, what, and when; use ${get} for exact-object grounding when needed. If no result directly supports the requested event, or the result lacks the metadata needed to distinguish it, say you do not remember or could not find it. Never invent or infer specifics absent from the retrieved objects. Use ${store} for deliberate durable memory. A store result is truthful about queued versus verified delivery; do not describe queued data as stored.`,
  ];
}

function registerTools(
  api: OpenClawPluginApi,
  client: MusubiClient,
  config: MusubiConfig,
  delivery: DeliveryController,
): void {
  const factory = <
    T extends {
      definition: {
        name: string;
        description: string;
        parameters: unknown;
        execute: (...args: never[]) => unknown;
      };
    },
  >(
    create: (ctx: { agentId?: string }) => T,
    name: string,
  ) => {
    const toolFactory = (ctx: { agentId?: string }) => {
      const definition = create(ctx).definition;
      return { ...definition, label: name, name };
    };
    api.registerTool(toolFactory as Parameters<OpenClawPluginApi["registerTool"]>[0], {
      names: [name],
    });
  };

  factory((ctx) => createSearchTool({ client, config, agentId: ctx.agentId }), "musubi_search");
  factory((ctx) => createSearchTool({ client, config, agentId: ctx.agentId }), "memory_search");
  factory((ctx) => createRecentTool({ client, config, agentId: ctx.agentId }), "musubi_recent");
  factory((ctx) => createGetTool({ client, config, agentId: ctx.agentId }), "musubi_get");
  factory((ctx) => createGetTool({ client, config, agentId: ctx.agentId }), "memory_get");
  factory((ctx) => createRememberTool({ delivery, agentId: ctx.agentId }), "musubi_remember");
  factory((ctx) => createRememberTool({ delivery, agentId: ctx.agentId }), "memory_store");
  factory((ctx) => createThinkTool({ client, config, agentId: ctx.agentId }), "musubi_think");
  factory(
    (ctx) =>
      createRecallTool({
        client,
        config,
        agentId: ctx.agentId,
        logger: { warn: (message) => api.logger.warn(message) },
      }),
    "musubi_recall",
  );
}

export function translateAgentEndEvent(event: unknown, agentId?: string): CaptureEvent | undefined {
  const result = translateAgentEndEventWithReason(event, agentId);
  return result.ok ? result.capture : undefined;
}

export function translateAgentEndEventWithReason(
  event: unknown,
  agentId?: string,
): AgentEndTranslation {
  if (!event || typeof event !== "object") return { ok: false, reason: "event_not_object" };
  const candidate = event as { messages?: unknown[]; runId?: unknown; sessionId?: unknown };
  if (!Array.isArray(candidate.messages)) return { ok: false, reason: "messages_missing" };

  let assistant: string | undefined;
  let user: string | undefined;
  for (let index = candidate.messages.length - 1; index >= 0; index -= 1) {
    const message = candidate.messages[index];
    const role = extractRole(message);
    const text = extractMessageText(message);
    if (!text) continue;
    if (!assistant && role === "assistant") {
      assistant = text;
      continue;
    }
    if (assistant && role === "user") {
      user = text;
      break;
    }
  }
  if (!assistant) return { ok: false, reason: "assistant_missing" };
  if (user !== undefined && isHeartbeatPoll(user)) {
    // Heartbeat polls are machine cadence, not lived experience. Before
    // this filter one identical heartbeat turn was enqueued 300+ times
    // per agent; the noise dominated `mode=recent`, forced the recall
    // floor in tools/search.ts, and fed the synthesis mega-cluster.
    // The assistant's reply to a heartbeat is derivative of memories
    // that were already captured on their original turns — anything an
    // agent genuinely wants to keep from a heartbeat goes through the
    // explicit `musubi_remember` path, which does not pass through here.
    return { ok: false, reason: "heartbeat_poll" };
  }
  const content = user ? `User:\n${user}\n\nAssistant:\n${assistant}` : `Assistant:\n${assistant}`;
  const runId = typeof candidate.runId === "string" ? candidate.runId : undefined;
  const sessionId = typeof candidate.sessionId === "string" ? candidate.sessionId : "unknown";
  const stableDigest = createStableDigest(`${agentId ?? "default"}\n${sessionId}\n${content}`);
  return {
    ok: true,
    capture: {
      id: runId ? `agent-end:${runId}` : `agent-end:${stableDigest}`,
      content,
      agentId,
    },
  };
}

/**
 * OpenClaw's heartbeat prompt as observed at the capture seam. Matched
 * when the user turn IS the poll marker (exactly, or the marker plus
 * trailing whitespace). Deliberately narrow: a human message that merely
 * mentions the marker mid-text still captures.
 */
const HEARTBEAT_POLL_MARKER = "[OpenClaw heartbeat poll]";

function isHeartbeatPoll(userText: string): boolean {
  const trimmed = userText.trim();
  return trimmed === HEARTBEAT_POLL_MARKER;
}

function extractRole(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const role = (message as { role?: unknown }).role;
  return typeof role === "string" ? role : undefined;
}

function extractMessageText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const value = (message as { content?: unknown; text?: unknown }).content;
  if (typeof value === "string") return value.trim() || undefined;
  if (Array.isArray(value)) {
    const text = value
      .map((part) => {
        if (!part || typeof part !== "object") return "";
        const row = part as { type?: unknown; text?: unknown };
        return row.type === "text" && typeof row.text === "string" ? row.text : "";
      })
      .filter(Boolean)
      .join("\n")
      .trim();
    return text || undefined;
  }
  const fallback = (message as { text?: unknown }).text;
  return typeof fallback === "string" && fallback.trim() ? fallback.trim() : undefined;
}

function createStableDigest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function formatStatus(
  status: ReturnType<DeliveryController["status"]>,
  capture: CaptureDiagnosticsSnapshot & { readonly hookRegistered: boolean },
): string {
  return [
    `Musubi memory: ${status.running ? (status.degraded ? "degraded" : "healthy") : "not running"}`,
    `pending=${status.pending} dead=${status.dead} failures=${status.consecutiveFailures}`,
    `oldest_pending_ms=${status.oldestPendingAgeMs} last_verified_ms=${status.lastVerifiedAtMs ?? "never"}`,
    `capture_observed=${capture.observed} translated=${capture.translated} enqueued=${capture.enqueued} enqueue_failed=${capture.enqueueFailed}`,
    `capture_hook_registered=${capture.hookRegistered}`,
    `capture_skipped=${JSON.stringify(capture.skipped)} last_observed_ms=${capture.lastObservedAtMs ?? "never"} last_enqueued_ms=${capture.lastEnqueuedAtMs ?? "never"}`,
  ].join("\n");
}

function captureStatus(
  diagnostics: CaptureDiagnostics,
): CaptureDiagnosticsSnapshot & { readonly hookRegistered: boolean } {
  const registry = getGlobalPluginRegistry();
  return {
    ...diagnostics.snapshot(),
    hookRegistered:
      registry?.typedHooks.some(
        (hook) => hook.pluginId === "musubi" && hook.hookName === "agent_end",
      ) ?? false,
  };
}

type CaptureDiagnosticOutcome =
  | CaptureSkipReason
  | "service_started"
  | "enqueued"
  | "enqueue_failed";

function logCaptureDiagnostic(
  api: OpenClawPluginApi,
  diagnostics: CaptureDiagnostics,
  outcome: CaptureDiagnosticOutcome,
): void {
  const capture = captureStatus(diagnostics);
  api.logger.info(
    `musubi: capture diagnostic outcome=${outcome} since_ms=${capture.sinceMs} hook_registered=${capture.hookRegistered} observed=${capture.observed} translated=${capture.translated} enqueued=${capture.enqueued} enqueue_failed=${capture.enqueueFailed} skipped=${JSON.stringify(capture.skipped)}`,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
