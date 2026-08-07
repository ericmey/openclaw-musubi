import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { awaitAgentEndSideEffects } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  getGlobalHookRunner,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/plugin-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OpenClawPluginApi } from "../../src/api.js";
import { registerMusubi } from "../../src/plugin/bootstrap.js";

type AgentEndHandler = (event: unknown, ctx: { agentId?: string }) => Promise<void>;
type Service = {
  start(ctx: { stateDir: string }): Promise<void> | void;
  stop(): Promise<void> | void;
};

const roots: string[] = [];

afterEach(() => {
  resetGlobalHookRunner();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function config(capture?: { completedTurns?: boolean }) {
  return {
    core: {
      baseUrl: "https://musubi.test",
      token: "mbi_test",
      perAgentTokens: { aoi: "mbi_aoi_test" },
    },
    presence: {
      defaultId: "eric/openclaw",
      perAgent: { aoi: "aoi/command-chair" },
    },
    capture,
  };
}

function makeApi() {
  let handler: AgentEndHandler | undefined;
  let service: Service | undefined;
  const api = {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    registerMemoryCapability: vi.fn(),
    registerTool: vi.fn(),
    on(name: string, value: unknown) {
      if (name === "agent_end") handler = value as AgentEndHandler;
    },
    registerService(value: unknown) {
      service = value as Service;
    },
    registerGatewayMethod: vi.fn(),
    registerCommand: vi.fn(),
    registerCli: vi.fn(),
  };
  return {
    api: api as unknown as OpenClawPluginApi,
    logger: api.logger,
    getHandler: () => {
      if (!handler) throw new Error("agent_end handler was not registered");
      return handler;
    },
    getService: () => {
      if (!service) throw new Error("Musubi service was not registered");
      return service;
    },
  };
}

describe("passive capture diagnostics", () => {
  it("counts bounded skip reasons without recording message content", async () => {
    const { api, getHandler, logger } = makeApi();
    const registered = registerMusubi({ api, rawConfig: config() });
    const handler = getHandler();

    await handler(null, {});
    await handler({}, {});
    await handler({ messages: [{ role: "user", content: "private prompt" }] }, {});

    expect(registered.captureDiagnostics.snapshot()).toEqual({
      sinceMs: expect.any(Number),
      observed: 3,
      translated: 0,
      enqueued: 0,
      enqueueFailed: 0,
      skipped: {
        capture_disabled: 0,
        event_not_object: 1,
        messages_missing: 1,
        assistant_missing: 1,
      },
      lastObservedAtMs: expect.any(Number),
      lastEnqueuedAtMs: null,
    });
    expect(JSON.stringify(registered.captureDiagnostics.snapshot())).not.toContain(
      "private prompt",
    );
    expect(logger.info.mock.calls.flat().join("\n")).not.toContain("private prompt");
    expect(logger.info).toHaveBeenCalledTimes(3);
    expect(logger.info.mock.calls.flat().join("\n")).toMatch(
      /outcome=event_not_object[\s\S]*outcome=messages_missing[\s\S]*outcome=assistant_missing/u,
    );
  });

  it("distinguishes disabled capture from translation failures", async () => {
    const { api, getHandler } = makeApi();
    const registered = registerMusubi({
      api,
      rawConfig: config({ completedTurns: false }),
    });

    await getHandler()({ messages: [{ role: "assistant", content: "answer" }] }, {});

    expect(registered.captureDiagnostics.snapshot()).toMatchObject({
      observed: 1,
      translated: 0,
      enqueued: 0,
      skipped: { capture_disabled: 1 },
    });
  });

  it("dispatches through OpenClaw's real harness side-effect path and reaches durable enqueue", async () => {
    const { api, getHandler, getService } = makeApi();
    const registered = registerMusubi({ api, rawConfig: config() });
    const stateDir = mkdtempSync(join(tmpdir(), "openclaw-musubi-hook-runner-"));
    roots.push(stateDir);
    const service = getService();
    await service.start({ stateDir });

    initializeGlobalHookRunner({
      hooks: [],
      typedHooks: [
        {
          pluginId: "musubi",
          hookName: "agent_end",
          handler: getHandler(),
          source: "capture-diagnostics-test",
        },
      ],
      plugins: [{ id: "musubi", status: "loaded" }],
    });

    try {
      const runner = getGlobalHookRunner();
      expect(runner).not.toBeNull();
      await awaitAgentEndSideEffects({
        event: {
          runId: "run-1",
          success: true,
          messages: [
            { role: "user", content: "synthetic question" },
            { role: "assistant", content: "synthetic answer" },
          ],
        },
        ctx: { agentId: "aoi", sessionId: "session-1" },
        hookRunner: runner,
      });

      expect(registered.captureDiagnostics.snapshot()).toMatchObject({
        observed: 1,
        translated: 1,
        enqueued: 1,
        enqueueFailed: 0,
        skipped: {
          capture_disabled: 0,
          event_not_object: 0,
          messages_missing: 0,
          assistant_missing: 0,
        },
      });
    } finally {
      await service.stop();
    }
  });
});
