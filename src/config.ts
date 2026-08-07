import { type Static, Type } from "@sinclair/typebox";

/**
 * Runtime plugin configuration shape. OpenClaw materializes the manifest's
 * declared SecretInput fields before plugin bootstrap, so the runtime schema
 * intentionally accepts resolved strings while `openclaw.plugin.json` also
 * accepts authored SecretRef objects at those paths.
 *
 * Keep every non-secret-input field in sync with `openclaw.plugin.json`.
 */
export const MusubiConfigSchema = Type.Object(
  {
    core: Type.Object(
      {
        baseUrl: Type.String({ format: "uri" }),
        token: Type.String(),
        requestTimeoutMs: Type.Optional(Type.Number({ minimum: 1000, maximum: 120_000 })),
        perAgentTokens: Type.Optional(Type.Record(Type.String(), Type.String())),
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

export type MusubiConfig = Static<typeof MusubiConfigSchema>;

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_RECONNECT_MAX_BACKOFF_MS = 30_000;
