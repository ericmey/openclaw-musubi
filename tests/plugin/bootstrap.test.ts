import { describe, expect, it, vi } from "vitest";

import type { OpenClawPluginApi } from "../../src/api.js";
import {
  registerMusubi,
  translateAgentEndEvent,
  translateAgentEndEventWithReason,
} from "../../src/plugin/bootstrap.js";

type Event =
  | { kind: "capability"; value: unknown }
  | { kind: "tool"; value: unknown; options: unknown }
  | { kind: "hook"; name: string; value: unknown }
  | { kind: "service"; value: unknown }
  | { kind: "gateway"; name: string }
  | { kind: "command"; value: unknown }
  | { kind: "cli" };

function makeApi() {
  const events: Event[] = [];
  const api = {
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    registerMemoryCapability(value: unknown) {
      events.push({ kind: "capability", value });
    },
    registerTool(value: unknown, options: unknown) {
      events.push({ kind: "tool", value, options });
    },
    on(name: string, value: unknown) {
      events.push({ kind: "hook", name, value });
    },
    registerService(value: unknown) {
      events.push({ kind: "service", value });
    },
    registerGatewayMethod(name: string) {
      events.push({ kind: "gateway", name });
    },
    registerCommand(value: unknown) {
      events.push({ kind: "command", value });
    },
    registerCli() {
      events.push({ kind: "cli" });
    },
  };
  return { api: api as unknown as OpenClawPluginApi, events, logger: api.logger };
}

function config(token = "mbi_test") {
  return {
    core: { baseUrl: "https://musubi.test", token },
    presence: {
      defaultId: "eric/openclaw",
      perAgent: { aoi: "aoi/command-chair" },
    },
    thoughts: { enabled: false },
  };
}

describe("registerMusubi", () => {
  it("degrades to one info line when token secrets are unresolved SecretRefs (CLI preview)", () => {
    // `openclaw doctor` / `plugins inspect` hand the plugin the AUTHORED
    // config — SecretRefs of any source (exec, env, …) unresolved, because
    // only the gateway materializes them before bootstrap. That is a
    // healthy config, not an invalid one: register must return null quietly
    // (no capability, no tools, no capture hook, no thrown "Expected
    // string") instead of printing nine register errors per doctor run.
    const { api, events } = makeApi();
    const secretRef = { source: "exec", provider: "onepassword", id: "musubi-hw-7ds-hana" };
    const raw = {
      core: {
        baseUrl: "https://musubi.test",
        token: secretRef,
        perAgentTokens: { hana: secretRef },
      },
      presence: { defaultId: "eric/openclaw" },
    };

    const registered = registerMusubi({ api, rawConfig: raw });

    expect(registered).toBeNull();
    expect(events).toHaveLength(0);
    expect(api.logger.info).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.logger.info).mock.calls[0]![0]).toContain("CLI preview");
    expect(api.logger.error).not.toHaveBeenCalled();
  });

  it("fails LOUDLY on malformed SecretRef shapes — never inert degradation", () => {
    // Yua's blocking finding on #55: a shape-loose ref schema let
    // {"source":"typo"} through, and `plugins inspect --runtime` then
    // reported Musubi as loaded with zero tools — invalid configuration
    // converted into healthy-looking inert degradation. Only OpenClaw's
    // exact SecretRef contract (source env|file|exec; provider + id
    // required; nothing extra) may degrade; everything else throws the
    // same loud validation error as any other config bug.
    const { api, events } = makeApi();
    const base = { presence: { defaultId: "eric/openclaw" } };
    const malformed: unknown[] = [
      { source: "typo", provider: "onepassword", id: "musubi-hw-7ds-hana" }, // unknown source
      { source: "exec" }, // missing provider + id
      { source: "exec", provider: "onepassword" }, // missing id
      { source: "exec", provider: "onepassword", id: "x", extra: true }, // additional property
      { provider: "onepassword", id: "x" }, // missing source entirely
    ];
    for (const token of malformed) {
      expect(
        () =>
          registerMusubi({
            api,
            rawConfig: { ...base, core: { baseUrl: "https://musubi.test", token } },
          }),
        `should throw for ${JSON.stringify(token)}`,
      ).toThrow(/invalid plugin config/u);
    }
    expect(events).toHaveLength(0);
    expect(api.logger.info).not.toHaveBeenCalled();
  });

  it("degrades quietly for every LEGITIMATE unresolved source: env, file, exec", () => {
    for (const source of ["env", "file", "exec"] as const) {
      const { api, events } = makeApi();
      const registered = registerMusubi({
        api,
        rawConfig: {
          core: {
            baseUrl: "https://musubi.test",
            token: { source, provider: "default", id: "MUSUBI_TOKEN" },
          },
          presence: { defaultId: "eric/openclaw" },
        },
      });
      expect(registered, `source=${source}`).toBeNull();
      expect(events, `source=${source}`).toHaveLength(0);
      expect(api.logger.info, `source=${source}`).toHaveBeenCalledTimes(1);
    }
  });

  it("still hard-refuses ${...} placeholder STRINGS (the 1.0 401 root cause)", () => {
    const { api } = makeApi();
    expect(() => registerMusubi({ api, rawConfig: config("${MUSUBI_TOKEN}") })).toThrow(
      /unresolved secret placeholder/,
    );
  });

  it("registers one exclusive capability, native aliases, service, status, and capture hook", () => {
    const { api, events } = makeApi();
    registerMusubi({ api, rawConfig: config() });

    expect(events.filter((event) => event.kind === "capability")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "service")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "hook")).toMatchObject([
      { kind: "hook", name: "agent_end" },
    ]);
    expect(events.filter((event) => event.kind === "gateway")).toMatchObject([
      { kind: "gateway", name: "musubi.status" },
    ]);
    expect(events.some((event) => event.kind === "command")).toBe(true);
    expect(events.some((event) => event.kind === "cli")).toBe(true);

    const names = events
      .filter((event): event is Extract<Event, { kind: "tool" }> => event.kind === "tool")
      .flatMap((event) => {
        const row = event.options as { names?: string[] };
        return row.names ?? [];
      })
      .sort();
    expect(names).toEqual([
      "memory_get",
      "memory_search",
      "memory_store",
      "musubi_get",
      "musubi_recall",
      "musubi_recent",
      "musubi_remember",
      "musubi_search",
      "musubi_think",
    ]);
  });

  it("fails synchronously before registration when config is invalid", () => {
    const { api, events } = makeApi();
    expect(() =>
      registerMusubi({
        api,
        rawConfig: { core: { token: "x" }, presence: { defaultId: "x/y" } },
      }),
    ).toThrow(/invalid plugin config/u);
    expect(events).toHaveLength(0);
  });

  it("rejects unresolved placeholders, including hyphenated names", () => {
    const { api, events } = makeApi();
    expect(() => registerMusubi({ api, rawConfig: config("${musubi-hw-7ds-vesper}") })).toThrow(
      /unresolved secret placeholder/u,
    );
    expect(events).toHaveLength(0);
  });

  it("registers a provider prompt that uses native memory aliases", () => {
    const { api, events } = makeApi();
    registerMusubi({ api, rawConfig: config() });
    const registration = events.find(
      (event): event is Extract<Event, { kind: "capability" }> => event.kind === "capability",
    );
    const capability = registration?.value as {
      promptBuilder: (params: { availableTools: Set<string> }) => string[];
    };
    const prompt = capability
      .promptBuilder({
        availableTools: new Set(["memory_search", "memory_get", "memory_store"]),
      })
      .join("\n");
    expect(prompt).toContain("memory_search");
    expect(prompt).toContain("memory_get");
    expect(prompt).toContain("semantically related candidates, not proof");
    expect(prompt).toContain("who, what, and when");
    expect(prompt).toContain("say you do not remember");
    expect(prompt).toContain("Never invent or infer specifics");
  });

  it("warns when accepted migration-only config is present", () => {
    const { api, logger } = makeApi();
    registerMusubi({
      api,
      rawConfig: {
        ...config(),
        supplement: { enabled: true },
        thoughts: { enabled: true },
        capture: { mirrorOpenClawMemory: true },
      },
    });
    expect(logger.warn).toHaveBeenCalledTimes(3);
    expect(logger.warn.mock.calls.flat().join("\n")).toMatch(/deprecated/u);
  });
});

describe("translateAgentEndEvent", () => {
  it("captures the nearest user/assistant pair and excludes tool sludge", () => {
    const translated = translateAgentEndEvent(
      {
        sessionId: "s1",
        messages: [
          { role: "user", content: "old prompt" },
          { role: "assistant", content: "old answer" },
          { role: "user", content: "real prompt" },
          { role: "tool", content: "private tool output" },
          { role: "assistant", content: [{ type: "text", text: "real answer" }] },
        ],
      },
      "aoi",
    );
    expect(translated?.content).toBe("User:\nreal prompt\n\nAssistant:\nreal answer");
    expect(translated?.content).not.toContain("private tool output");
  });

  it("derives the same source identity without random or wall-clock input", () => {
    const event = {
      sessionId: "s1",
      messages: [
        { role: "user", content: "q" },
        { role: "assistant", content: "a" },
      ],
    };
    expect(translateAgentEndEvent(event, "aoi")?.id).toBe(translateAgentEndEvent(event, "aoi")?.id);
  });

  it("skips heartbeat-poll turns with a dedicated diagnostics reason", () => {
    // One identical heartbeat turn was enqueued 300+ times per agent
    // before this filter; the noise dominated recent-mode retrieval and
    // fed the synthesis mega-cluster. Machine cadence is not memory.
    const result = translateAgentEndEventWithReason(
      {
        sessionId: "s1",
        messages: [
          { role: "user", content: "  [OpenClaw heartbeat poll] \n" },
          { role: "assistant", content: "Caught up on the house. NO_REPLY" },
        ],
      },
      "aoi",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("heartbeat_poll");
  });

  it("still captures a human turn that merely mentions the heartbeat marker", () => {
    const translated = translateAgentEndEvent(
      {
        sessionId: "s1",
        messages: [
          { role: "user", content: "why does [OpenClaw heartbeat poll] show up in my logs?" },
          { role: "assistant", content: "because the gateway polls each agent." },
        ],
      },
      "aoi",
    );
    expect(translated?.content).toContain("why does [OpenClaw heartbeat poll] show up");
  });
});
