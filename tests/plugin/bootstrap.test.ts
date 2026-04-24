import { describe, it, expect, vi } from "vitest";

import type { MusubiConfig } from "../../src/config.js";
import type { FetchLike } from "../../src/musubi/types.js";
import {
  bootstrap,
  type BootstrapOptions,
  type BootstrapPluginApi,
} from "../../src/plugin/bootstrap.js";
import type { Scheduler } from "../../src/plugin/lifecycle.js";
import type { ThoughtStream, ThoughtStreamHandlers } from "../../src/thoughts/stream.js";

type RegistrationEvent =
  | { kind: "registerMemoryCorpusSupplement"; arg: unknown }
  | { kind: "registerMemoryPromptSupplement"; arg: unknown }
  | { kind: "registerTool"; arg: unknown }
  | { kind: "on"; hook: string };

type MockApi = BootstrapPluginApi & {
  readonly events: RegistrationEvent[];
  readonly logger: BootstrapPluginApi["logger"] & {
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
    debug: ReturnType<typeof vi.fn>;
  };
};

function makeApi(): MockApi {
  const events: RegistrationEvent[] = [];
  return {
    events,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    registerMemoryCorpusSupplement(arg) {
      events.push({ kind: "registerMemoryCorpusSupplement", arg });
    },
    registerMemoryPromptSupplement(arg) {
      events.push({ kind: "registerMemoryPromptSupplement", arg });
    },
    registerTool(arg) {
      events.push({ kind: "registerTool", arg });
    },
    on(hook) {
      events.push({ kind: "on", hook });
    },
  };
}

function makeRawConfig(overrides: Partial<MusubiConfig> = {}): unknown {
  return {
    core: {
      baseUrl: "https://musubi.test.internal",
      token: "mbi_test_token",
      ...(overrides.core ?? {}),
    },
    presence: {
      defaultId: "eric/openclaw",
      ...(overrides.presence ?? {}),
    },
    ...(overrides.supplement !== undefined ? { supplement: overrides.supplement } : {}),
    ...(overrides.capture !== undefined ? { capture: overrides.capture } : {}),
    ...(overrides.thoughts !== undefined ? { thoughts: overrides.thoughts } : {}),
  };
}

function makeStubScheduler(): Scheduler & { _started: boolean; _stopped: boolean } {
  const s = {
    _started: false,
    _stopped: false,
    start() {
      s._started = true;
    },
    stop() {
      s._stopped = true;
    },
  };
  return s;
}

function makeStubStream(): ThoughtStream & {
  _started: boolean;
  _stopped: boolean;
  _handlers?: ThoughtStreamHandlers;
} {
  const s = {
    _started: false,
    _stopped: false,
    _handlers: undefined as ThoughtStreamHandlers | undefined,
    async start(handlers: ThoughtStreamHandlers): Promise<void> {
      s._started = true;
      s._handlers = handlers;
    },
    async stop(): Promise<void> {
      s._stopped = true;
    },
    isRunning: () => s._started && !s._stopped,
    __backoffAttempt: () => 0,
  };
  return s;
}

function commonOpts(
  api: BootstrapPluginApi,
  overrides: Partial<BootstrapOptions> = {},
): BootstrapOptions {
  const fetch: FetchLike = async () =>
    new Response(JSON.stringify({ results: [] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  return {
    api,
    rawConfig: makeRawConfig(),
    fetch,
    schedulerFactory: () => makeStubScheduler(),
    thoughtStreamFactory: () => makeStubStream(),
    ...overrides,
  };
}

// --------------------------------------------------------------------------
// Bullet 1
// --------------------------------------------------------------------------

describe("bootstrap: config parsing", () => {
  it("accepts a valid config with defaults applied", async () => {
    const api = makeApi();
    const handle = await bootstrap(commonOpts(api));
    expect(handle).toBeDefined();
    expect(api.logger.info).toHaveBeenCalled();
  });

  // Bullet 10
  it("fails loud on invalid config (missing core.baseUrl)", async () => {
    const api = makeApi();
    const rawConfig = {
      // core.baseUrl omitted
      core: { token: "mbi_x" },
      presence: { defaultId: "eric/openclaw" },
    };
    await expect(bootstrap(commonOpts(api, { rawConfig }))).rejects.toThrow(
      /invalid plugin config/i,
    );
  });
});

// --------------------------------------------------------------------------
// Bullets 2, 3, 4, 7 — each registration happens
// --------------------------------------------------------------------------

describe("bootstrap: capability registration", () => {
  it("registers the memory corpus supplement", async () => {
    const api = makeApi();
    await bootstrap(commonOpts(api));
    const corpus = api.events.find((e) => e.kind === "registerMemoryCorpusSupplement");
    expect(corpus).toBeDefined();
    expect(corpus?.arg).toBeDefined();
  });

  it("registers the memory prompt supplement", async () => {
    const api = makeApi();
    await bootstrap(commonOpts(api));
    const prompt = api.events.find((e) => e.kind === "registerMemoryPromptSupplement");
    expect(prompt).toBeDefined();
    // The registered value is a `MemoryPromptSectionBuilder` — a callable
    // that OpenClaw invokes per prompt assembly.
    expect(typeof prompt?.arg).toBe("function");
  });

  it("registers an agent_end hook for the capture mirror", async () => {
    const api = makeApi();
    await bootstrap(commonOpts(api));
    const hook = api.events.find((e) => e.kind === "on" && e.hook === "agent_end");
    expect(hook).toBeDefined();
  });

  it("registers all three agent tools: recall, remember, think", async () => {
    const api = makeApi();
    await bootstrap(commonOpts(api));
    const tools = api.events.filter((e) => e.kind === "registerTool");
    expect(tools).toHaveLength(3);
    const names = tools
      .map((t) => {
        const arg = t.arg as unknown;
        // OpenClaw supports both static tools and factory functions.
        // Factories receive { agentId?: string } at execution time.
        const tool =
          typeof arg === "function"
            ? (arg as (ctx: { agentId?: string }) => { name: string })({ agentId: "test" })
            : (arg as { name: string });
        return tool.name;
      })
      .sort();
    expect(names).toEqual(["musubi_recall", "musubi_remember", "musubi_think"]);
  });
});

// --------------------------------------------------------------------------
// Bullets 5, 6 — thought stream conditional start
// --------------------------------------------------------------------------

describe("bootstrap: thought stream", () => {
  it("starts the SSE stream when thoughts.enabled !== false", async () => {
    const api = makeApi();
    const stream = makeStubStream();
    await bootstrap(
      commonOpts(api, {
        thoughtStreamFactory: () => stream,
      }),
    );
    // start() is fire-and-forget; give the microtask queue a beat.
    await new Promise((resolve) => setImmediate(resolve));
    expect(stream._started).toBe(true);
  });

  it("skips the SSE stream when thoughts.enabled === false", async () => {
    const api = makeApi();
    const stream = makeStubStream();
    await bootstrap(
      commonOpts(api, {
        rawConfig: makeRawConfig({ thoughts: { enabled: false } }),
        thoughtStreamFactory: () => stream,
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(stream._started).toBe(false);
  });
});

// --------------------------------------------------------------------------
// Bullets 8, 9 — lifecycle handle + stop
// --------------------------------------------------------------------------

describe("bootstrap: lifecycle handle", () => {
  it("returns a handle exposing stop()", async () => {
    const api = makeApi();
    const handle = await bootstrap(commonOpts(api));
    expect(typeof handle.stop).toBe("function");
    expect(handle.isStopped()).toBe(false);
  });

  it("stop() cancels the refresh scheduler and the stream subscription", async () => {
    const api = makeApi();
    const scheduler = makeStubScheduler();
    const stream = makeStubStream();
    const handle = await bootstrap(
      commonOpts(api, {
        schedulerFactory: () => scheduler,
        thoughtStreamFactory: () => stream,
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(scheduler._started).toBe(true);
    expect(stream._started).toBe(true);

    await handle.stop();

    expect(scheduler._stopped).toBe(true);
    expect(stream._stopped).toBe(true);
    expect(handle.isStopped()).toBe(true);
  });
});

// --------------------------------------------------------------------------
// Bullet 11 — integration: every register call is made in the right order
// --------------------------------------------------------------------------

describe("bootstrap: integration wiring", () => {
  it("registers every capability in a stable order", async () => {
    const api = makeApi();
    await bootstrap(commonOpts(api));

    const kinds = api.events.map((e) => {
      if (e.kind === "on") return `on:${e.hook}`;
      if (e.kind === "registerTool") {
        const arg = e.arg as unknown;
        const tool =
          typeof arg === "function"
            ? (arg as (ctx: { agentId?: string }) => { name?: string })({ agentId: "test" })
            : (arg as { name?: string });
        const name = tool.name ?? "<unnamed>";
        return `registerTool:${name}`;
      }
      return e.kind;
    });

    expect(kinds).toEqual([
      "registerMemoryCorpusSupplement",
      "registerMemoryPromptSupplement",
      "registerTool:musubi_recall",
      "registerTool:musubi_remember",
      "registerTool:musubi_think",
      "on:agent_end",
    ]);
  });
});
