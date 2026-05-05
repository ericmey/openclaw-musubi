import { type Static, Type } from "@sinclair/typebox";

/**
 * TypeBox schemas for the three agent-callable Musubi tools. The wiring
 * slice passes these to OpenClaw's `api.registerTool(...)` (typebox
 * schemas are what the plugin SDK's Quick Start example uses — see
 * `docs/plugins/building-plugins.md`).
 */

export const PLANE_ENUM = ["curated", "concept", "episodic", "artifact"] as const;

/**
 * Canonical name per [[07-interfaces/agent-tools]] / ADR 0032.
 *
 * `musubi_recall` is the legacy name; `RecallParameters` is re-exported
 * below as an alias so existing call-sites keep compiling during the
 * one-release deprecation window.
 */
export const SearchParameters = Type.Object(
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

/** @deprecated Use {@link SearchParameters}. Removed after one minor release. */
export const RecallParameters = SearchParameters;

export const RecentParameters = Type.Object(
  {
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 50,
        description:
          "Max rows to return. Defaults to 10. Returns the N most recent episodic captures in the agent's presence namespace.",
      }),
    ),
    since: Type.Optional(
      Type.String({
        description:
          "ISO-8601 timestamp lower bound. Returns only rows captured at or after this time. Absent = newest items, no time filter.",
      }),
    ),
    tags: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Filter to rows whose `tags` contains every listed tag. Useful for narrowing to a specific modality (`src:openclaw-agent-remember`) or topic.",
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
        minimum: 1,
        maximum: 10,
        description:
          "Importance hint 1-10. Default 7 (agents explicitly remembering is higher-signal than passive capture).",
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

export const GetParameters = Type.Object(
  {
    plane: Type.Union(
      PLANE_ENUM.map((p) => Type.Literal(p)),
      {
        description:
          "Which plane the object lives in. Recall results expose this as the `[plane]` label.",
      },
    ),
    namespace: Type.String({
      minLength: 1,
      description:
        "Namespace the object belongs to, exactly as returned by recall (e.g. 'eric/aoi-phone/episodic' or 'eric/_shared/curated').",
    }),
    object_id: Type.String({
      minLength: 1,
      description: "Stable id of the object — copy verbatim from a recall result.",
    }),
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
        minimum: 1,
        maximum: 10,
        description: "Priority hint 1-10. Default 5.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type SearchParams = Static<typeof SearchParameters>;
/** @deprecated Use {@link SearchParams}. Removed after one minor release. */
export type RecallParams = SearchParams;
export type RememberParams = Static<typeof RememberParameters>;
export type ThinkParams = Static<typeof ThinkParameters>;
export type GetParams = Static<typeof GetParameters>;
export type RecentParams = Static<typeof RecentParameters>;
