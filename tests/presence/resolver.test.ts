import { describe, it, expect } from "vitest";
import type { MusubiConfig } from "../../src/config.js";
import { resolvePresence } from "../../src/presence/resolver.js";
import { PresenceResolutionError } from "../../src/presence/errors.js";

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
        curatedReadScope: ["eric/aoi/curated", "eric/_shared/curated", "eric/_shared/concept"],
      },
    });
  });

  it("test_resolver_handles_env_var_substitution_in_tokens", () => {
    const config = makeConfig({
      core: {
        baseUrl: "https://musubi.test",
        token: "${MUSUBI_TOKEN_DEFAULT}",
        perAgentTokens: {
          aoi: "${MUSUBI_TOKEN_AOI}",
          rin: "no-substitution-here",
          partial: "prefix-${MUSUBI_PART}-suffix",
        },
      },
      presence: {
        defaultId: "eric/openclaw",
        perAgent: { aoi: "eric/aoi", rin: "eric/rin", partial: "eric/partial" },
      },
    });

    const env = {
      MUSUBI_TOKEN_DEFAULT: "expanded-default",
      MUSUBI_TOKEN_AOI: "expanded-aoi",
      MUSUBI_PART: "expanded-part",
    };

    const def = resolvePresence(config, { env });
    const aoi = resolvePresence(config, { agentId: "aoi", env });
    const rin = resolvePresence(config, { agentId: "rin", env });
    const partial = resolvePresence(config, { agentId: "partial", env });

    expect(def.token).toBe("expanded-default");
    expect(aoi.token).toBe("expanded-aoi");
    expect(rin.token).toBe("no-substitution-here");
    expect(partial.token).toBe("prefix-expanded-part-suffix");
  });

  it("leaves unresolved env vars literal so misconfiguration is visible", () => {
    const config = makeConfig({
      core: { baseUrl: "https://musubi.test", token: "${MUSUBI_NOT_SET}" },
    });

    const ctx = resolvePresence(config, { env: {} });

    expect(ctx.token).toBe("${MUSUBI_NOT_SET}");
  });
});
