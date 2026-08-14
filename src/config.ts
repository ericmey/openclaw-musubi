import { type Static, Type } from "@sinclair/typebox";

/**
 * An UNRESOLVED SecretRef, exactly as authored in `openclaw.json`, mirroring
 * OpenClaw's own contract verbatim (`src/config/types.secrets.d.ts`):
 *
 *   type SecretRefSource = "env" | "file" | "exec";
 *   type SecretRef = { source: SecretRefSource; provider: string; id: string };
 *
 * The mirror is deliberately EXACT — closed `source` set, all three fields
 * required, no additional properties. A malformed object such as
 * `{"source":"typo"}` is NOT an unresolved secret; it is an invalid config
 * and must fail registration loudly, exactly like any other schema
 * violation. Admitting it would convert broken configuration into
 * healthy-looking inert degradation (plugin "loaded", zero tools), which is
 * the silent-failure class this codebase exists to refuse.
 *
 * The gateway materializes legitimate refs to strings before plugin
 * bootstrap (via the manifest's `configContracts.secretInputs.paths`), so at
 * runtime the token fields are plain strings. CLI preview contexts —
 * `openclaw doctor`, `openclaw plugins inspect` — do NOT run secret
 * resolution and hand the plugin the raw authored objects. The schema must
 * accept that (legitimate) shape or every doctor run reports "invalid
 * plugin config at /core/token: Expected string" nine times for a config
 * that is perfectly healthy in the gateway. Registration detects the
 * unresolved shape and degrades quietly instead (see `secretsMaterialized`
 * in plugin/bootstrap.ts).
 */
/**
 * OpenClaw 2026.7.1 additionally requires `provider` and `id` to contain at
 * least one non-whitespace character (`value.provider.trim().length > 0`,
 * same for `id`). The `\S` pattern is the JSON-schema equivalent of that
 * trim check: it admits exactly the strings whose `trim()` is non-empty.
 * Without it, `{"source":"env","provider":"","id":""}` degraded quietly —
 * the loader exits 0 and reports Musubi loaded with zero tools, the same
 * inert-failure class as the unknown-source case (Yua, #55 round 2).
 */
const NonBlankString = Type.String({ pattern: "\\S" });

export const SecretRefSchema = Type.Object(
  {
    source: Type.Union([Type.Literal("env"), Type.Literal("file"), Type.Literal("exec")]),
    provider: NonBlankString,
    id: NonBlankString,
  },
  { additionalProperties: false },
);

const TokenValue = Type.Union([Type.String(), SecretRefSchema]);

/**
 * Runtime plugin configuration shape. OpenClaw materializes the manifest's
 * declared SecretInput fields before plugin bootstrap, so in the gateway the
 * token fields arrive as resolved strings; in CLI preview contexts they stay
 * authored SecretRef objects (accepted, handled as degraded — see above).
 *
 * Keep every non-secret-input field in sync with `openclaw.plugin.json`.
 */
export const MusubiConfigSchema = Type.Object(
  {
    core: Type.Object(
      {
        baseUrl: Type.String({ format: "uri" }),
        token: TokenValue,
        requestTimeoutMs: Type.Optional(Type.Number({ minimum: 1000, maximum: 120_000 })),
        perAgentTokens: Type.Optional(Type.Record(Type.String(), TokenValue)),
      },
      { additionalProperties: false },
    ),
    presence: Type.Object(
      {
        defaultId: Type.String(),
        perAgent: Type.Optional(Type.Record(Type.String(), Type.String())),
      },
      { additionalProperties: false },
    ),
    /**
     * Deprecated 1.0 compatibility block. Accepted so an existing config can
     * upgrade without a validation outage; first-class Musubi ignores it.
     */
    supplement: Type.Optional(
      Type.Object(
        {
          enabled: Type.Optional(Type.Boolean()),
          planes: Type.Optional(
            Type.Array(
              Type.Union([
                Type.Literal("curated"),
                Type.Literal("concept"),
                Type.Literal("episodic"),
                Type.Literal("artifact"),
              ]),
            ),
          ),
          maxResults: Type.Optional(Type.Number({ minimum: 1, maximum: 50 })),
        },
        { additionalProperties: false },
      ),
    ),
    capture: Type.Optional(
      Type.Object(
        {
          completedTurns: Type.Optional(Type.Boolean()),
          /** Deprecated alias for completedTurns. */
          mirrorOpenClawMemory: Type.Optional(Type.Boolean()),
        },
        { additionalProperties: false },
      ),
    ),
    thoughts: Type.Optional(
      Type.Object(
        {
          enabled: Type.Optional(Type.Boolean()),
          reconnect: Type.Optional(
            Type.Object(
              {
                maxBackoffMs: Type.Optional(Type.Number({ minimum: 1000, maximum: 600_000 })),
              },
              { additionalProperties: false },
            ),
          ),
        },
        { additionalProperties: false },
      ),
    ),
  },
  { additionalProperties: false },
);

/**
 * The config exactly as the schema admits it: token fields may still be
 * authored SecretRef objects (CLI preview contexts). Only bootstrap's
 * materialization guard should touch this type.
 */
export type AuthoredMusubiConfig = Static<typeof MusubiConfigSchema>;

/**
 * The config every runtime consumer sees: secrets materialized to strings.
 * `registerMusubi` narrows Authored → Musubi via `secretsMaterialized` and
 * returns early (degraded, no tools) when the narrowing fails — so client,
 * delivery, and presence code never meet a SecretRef object.
 */
export type MusubiConfig = AuthoredMusubiConfig & {
  core: Omit<AuthoredMusubiConfig["core"], "token" | "perAgentTokens"> & {
    token: string;
    perAgentTokens?: Record<string, string>;
  };
};

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_RECONNECT_MAX_BACKOFF_MS = 30_000;
