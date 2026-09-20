import { describe, expect, it } from "vitest";
import type { MusubiConfig } from "../../src/config.js";
import { PresenceResolutionError } from "../../src/presence/errors.js";
import { resolvePresence } from "../../src/presence/resolver.js";

type PresenceConfig = Pick<MusubiConfig, "core" | "presence">;

function makeConfig(overrides: Partial<PresenceConfig> = {}): PresenceConfig {
  return {
    core: {
      baseUrl: "https://musubi.test",
      token: "default-token",
      ...(overrides.core ?? {}),
    },
    presence: {
      defaultId: "eric/openclaw",
      ...(overrides.presence ?? {}),
    },
  };
}

describe("resolvePresence", () => {
  it("test_resolver_shared_mode_uses_default_presence_and_core_token", () => {
    const config = makeConfig();
    const ctx = resolvePresence(config);

    expect(ctx.presence).toBe("eric/openclaw");
    expect(ctx.token).toBe("default-token");
  });

  it("test_resolver_per_agent_mode_resolves_mapped_presence", () => {
    const config = makeConfig({
      presence: {
        defaultId: "eric/openclaw",
        perAgent: { aoi: "eric/aoi", rin: "eric/rin" },
      },
    });

    const aoi = resolvePresence(config, { agentId: "aoi" });
    const rin = resolvePresence(config, { agentId: "rin" });

    expect(aoi.presence).toBe("eric/aoi");
    expect(rin.presence).toBe("eric/rin");
  });

  it("test_resolver_unknown_agent_falls_back_to_default_presence", () => {
    const config = makeConfig({
      presence: {
        defaultId: "eric/openclaw",
        perAgent: { aoi: "eric/aoi" },
      },
    });

    const ctx = resolvePresence(config, { agentId: "yua-not-mapped" });

    expect(ctx.presence).toBe("eric/openclaw");
    expect(ctx.token).toBe("default-token");
  });

  it("test_resolver_uses_per_agent_token_when_configured", () => {
    const config = makeConfig({
      core: {
        baseUrl: "https://musubi.test",
        token: "default-token",
        perAgentTokens: { aoi: "aoi-secret-token" },
      },
      presence: {
        defaultId: "eric/openclaw",
        perAgent: { aoi: "eric/aoi" },
      },
    });

    const ctx = resolvePresence(config, { agentId: "aoi" });

    expect(ctx.token).toBe("aoi-secret-token");
    expect(ctx.presence).toBe("eric/aoi");
  });

  it("test_resolver_falls_back_to_core_token_when_per_agent_token_missing", () => {
    const config = makeConfig({
      core: {
        baseUrl: "https://musubi.test",
        token: "default-token",
        perAgentTokens: { aoi: "aoi-secret-token" },
      },
      presence: {
        defaultId: "eric/openclaw",
        perAgent: { aoi: "eric/aoi", rin: "eric/rin" },
      },
    });

    // rin has a presence mapping but no per-agent token; non-strict should
    // fall back gracefully to core.token.
    const ctx = resolvePresence(config, { agentId: "rin" });

    expect(ctx.presence).toBe("eric/rin");
    expect(ctx.token).toBe("default-token");
  });

  it("test_resolver_errors_when_per_agent_map_set_but_tokens_missing_and_strict_mode_enabled", () => {
    const config = makeConfig({
      presence: {
        defaultId: "eric/openclaw",
        perAgent: { aoi: "eric/aoi" },
      },
    });

    expect(() => resolvePresence(config, { agentId: "aoi", strict: true })).toThrowError(
      PresenceResolutionError,
    );

    try {
      resolvePresence(config, { agentId: "aoi", strict: true });
    } catch (e) {
      expect(e).toBeInstanceOf(PresenceResolutionError);
      const err = e as PresenceResolutionError;
      expect(err.code).toBe("strict-mode-mismatch");
      expect(err.agentId).toBe("aoi");
    }
  });

  it("test_resolver_returns_scoped_context_with_presence_token_namespace_hints", () => {
    const config = makeConfig({
      presence: {
        defaultId: "eric/openclaw",
        perAgent: { aoi: "eric/aoi" },
      },
    });

    const ctx = resolvePresence(config, { agentId: "aoi" });

    expect(ctx).toEqual({
      presence: "eric/aoi",
      token: "default-token",
      namespaces: {
        episodic: "eric/aoi/episodic",
        thought: "eric/aoi/thought",
        artifact: "eric/aoi/artifact",
        curatedReadScope: ["eric/aoi/curated", "eric/_shared/curated", "eric/_shared/concept"],
      },
    });
  });

  it("passes materialized tokens through verbatim", () => {
    // `${...}` interpolation is NOT the resolver's job and never was reachable:
    // registration hard-refuses any token string containing a placeholder
    // (see plugin/bootstrap.test.ts), because a placeholder reaching the wire
    // is a silent 401. Secret resolution is OpenClaw's SecretRef contract.
    const config = makeConfig({
      core: {
        baseUrl: "https://musubi.test",
        token: "default-token",
        perAgentTokens: { aoi: "aoi-token" },
      },
      presence: { defaultId: "eric/openclaw", perAgent: { aoi: "eric/aoi" } },
    });

    expect(resolvePresence(config).token).toBe("default-token");
    expect(resolvePresence(config, { agentId: "aoi" }).token).toBe("aoi-token");
  });
});
