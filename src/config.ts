import { Type, type Static } from "@sinclair/typebox";

/**
 * Plugin configuration shape, mirroring `openclaw.plugin.json`'s
 * `configSchema`. The manifest is the authoritative source for validation at
 * install time; this TypeBox schema gives us typed access at runtime.
 *
 * Keep in sync with `openclaw.plugin.json`. A future slice will add a
 * schema-parity test to enforce this.
 */
export const MusubiConfigSchema = Type.Object(
  {
    core: Type.Object(
      {
        baseUrl: Type.String({ format: "uri" }),
        token: Type.String(),
        requestTimeoutMs: Type.Optional(Type.Number({ minimum: 1000, maximum: 120_000 })),
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

export const DEFAULT_SUPPLEMENT_PLANES = ["curated", "concept"] as const;
export const DEFAULT_SUPPLEMENT_MAX_RESULTS = 5;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_RECONNECT_MAX_BACKOFF_MS = 30_000;
