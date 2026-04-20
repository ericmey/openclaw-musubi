import { Type, type Static } from "@sinclair/typebox";

/**
 * TypeBox schemas for the three agent-callable Musubi tools. The wiring
 * slice passes these to OpenClaw's `api.registerTool(...)` (typebox
 * schemas are what the plugin SDK's Quick Start example uses — see
 * `docs/plugins/building-plugins.md`).
 */

export const PLANE_ENUM = ["curated", "concept", "episodic", "artifact"] as const;

export const RecallParameters = Type.Object(
  {
    query: Type.String({
      minLength: 1,
      description: "Natural-language query to search Musubi with.",
    }),
    planes: Type.Optional(
      Type.Array(Type.Union(PLANE_ENUM.map((p) => Type.Literal(p))), {
        description:
          "Restrict results to specific planes. Default: all four. Use [curated, concept] for facts, [episodic] for conversation history.",
      }),
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 50,
        description: "Max rows to return. Defaults to 10.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const RememberParameters = Type.Object(
  {
    content: Type.String({
      minLength: 1,
      description: "The thing worth remembering. One fact or observation per call.",
    }),
    importance: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 10,
        description:
          "Importance hint 0-10. Default 7 (agents explicitly remembering is higher-signal than passive capture).",
      }),
    ),
    topics: Type.Optional(
      Type.Array(Type.String(), {
        description: "Topic tags for later filtering.",
      }),
    ),
    idempotencyKey: Type.Optional(
      Type.String({
        description:
          "Override the auto-generated idempotency key. Use when the agent has a stable client-side id for the thing being remembered.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const ThinkParameters = Type.Object(
  {
    toPresence: Type.String({
      minLength: 1,
      description:
        "Destination presence id, e.g. 'eric/claude-code' or 'eric/rin'. Use 'all' to broadcast.",
    }),
    content: Type.String({
      minLength: 1,
      description: "The message to send to the other presence.",
    }),
    channel: Type.Optional(
      Type.String({
        description: "Optional channel name. Defaults to the configured channel.",
      }),
    ),
    importance: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 10,
        description: "Priority hint 0-10. Default 5.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type RecallParams = Static<typeof RecallParameters>;
export type RememberParams = Static<typeof RememberParameters>;
export type ThinkParams = Static<typeof ThinkParameters>;
