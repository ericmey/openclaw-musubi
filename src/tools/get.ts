import type { MusubiConfig } from "../config.js";
import type { MusubiClient } from "../musubi/client.js";
import { MusubiError, NotFoundError } from "../musubi/errors.js";
import { type PresenceContext, resolvePresence } from "../presence/resolver.js";
import { PLANE_PATH } from "../retrieval/targets.js";
import { GetParameters, type GetParams } from "./parameters.js";

/**
 * Agent-callable fetch-by-id across every Musubi plane.
 *
 * `recall` returns ranked snippets — useful when the agent is exploring
 * but lossy when they want to ground a turn on the actual content of one
 * specific object. `get` is the deep-link companion: take the
 * `(plane, namespace, object_id)` triple from a recall row and pull the
 * full underlying object back, with all its metadata, so the agent can
 * speak about source instead of paraphrase.
 *
 * Read-only. Hits the existing per-plane GET endpoints
 * (`/v1/curated/{id}`, `/v1/concepts/{id}`, `/v1/episodic/{id}`,
 * `/v1/artifacts/{id}`) — no backend work required.
 */

export type ToolDefinition = {
  readonly name: string;
  readonly description: string;
  readonly parameters: typeof GetParameters;
  execute(toolCallId: string, params: GetParams): Promise<ToolResult>;
};

export type ToolResult = {
  readonly content: ReadonlyArray<{ type: "text"; text: string }>;
  readonly isError?: boolean;
};

export type CreateGetToolOptions = {
  readonly client: MusubiClient;
  readonly config: MusubiConfig;
  /** OpenClaw agent id for presence resolution. */
  readonly agentId?: string;
};

export type GetTool = {
  readonly definition: ToolDefinition;
  /** Hint to the wiring slice: this tool is opt-in per-agent, not required. */
  readonly recommendedOptional: true;
};

/**
 * Map plane → API path prefix lives in `retrieval/targets.ts` so the
 * exact-read tool and ranked retrieval share one source of truth.
 */

/**
 * Mirror the search/recent identity-boundary guard for exact reads.
 *
 * `musubi_get` drills into a single object whose `(plane, namespace,
 * object_id)` triple comes from a recall row. If a foreign namespace
 * reaches the tool — a stale system prompt, a copied-from-shared-result
 * snippet, an explicit foreign probe — and the resolved token authenticates
 * the foreign family, the server may return the foreign object under the
 * caller's own request. ADR-0005 calls out the same class of failure on
 * the retrieval path; the readback path is the deeper sink that turns a
 * recall misbinding into concrete cited content.
 *
 * Fail closed before the GET: never merge, surface, or log a row whose
 * namespace's owner differs from the configured presence. The operator
 * sees the misbinding; the agent sees no object.
 */
function assertNamespaceInIdentityFamily(
  expectedOwner: string,
  namespace: string,
  plane: GetParams["plane"],
): string | undefined {
  const rowOwner = namespace.split("/", 1)[0];
  if (rowOwner === expectedOwner) return undefined;
  return (
    `Musubi identity boundary violation: get received namespace "${namespace}" ` +
    `outside the configured identity "${expectedOwner}/…". No object was surfaced. ` +
    `This means the object_id came from a recall row owned by a different ` +
    `identity family — check ` +
    `plugins.entries.musubi.config.core.perAgentTokens for this agent ` +
    `before retrying (plane=${plane}).`
  );
}

export function createGetTool(options: CreateGetToolOptions): GetTool {
  const { client, config, agentId } = options;

  return {
    recommendedOptional: true,
    definition: {
      name: "musubi_get",
      description:
        "Fetch the full content + metadata of one Musubi object by id. Use after `musubi_recall` when a snippet looks load-bearing and the agent needs to drill into the source. Pass the `plane`, `namespace`, and `object_id` straight from the recall result.",
      parameters: GetParameters,
      async execute(_toolCallId, params) {
        let presence: PresenceContext;
        try {
          presence = resolvePresence(config, { agentId });
        } catch (err) {
          return toolError(`Presence unresolved: ${errorMessage(err)}`);
        }

        // Identity-boundary check FIRST, before any HTTP work or content
        // handling. The recall row that fed the agent the object_id may
        // have come from a foreign family (system-prompt drift, cross-
        // agent snippet reuse, an explicit probe). Fail closed rather
        // than hit the wire with a request the server will answer from a
        // different identity family.
        const expectedOwner = presence.presence.split("/", 1)[0] ?? "";
        if (expectedOwner === "") {
          return toolError(`Invalid presence "${presence.presence}"`);
        }
        const boundaryError = assertNamespaceInIdentityFamily(
          expectedOwner,
          params.namespace,
          params.plane,
        );
        if (boundaryError !== undefined) {
          return toolError(boundaryError);
        }

        const path = `${PLANE_PATH[params.plane]}/${encodeURIComponent(params.object_id)}`;

        try {
          const row = await client.getWithQuery<Record<string, unknown>>(
            path,
            { namespace: params.namespace },
            { token: presence.token },
          );
          return toolText(formatObject(params.plane, params.namespace, params.object_id, row));
        } catch (err) {
          if (err instanceof NotFoundError) {
            return toolError(
              `Musubi has no ${params.plane} object ${params.object_id} in namespace ${params.namespace}.`,
            );
          }
          return toolError(`Musubi get failed: ${errorMessage(err)}`);
        }
      },
    },
  };
}

/**
 * Render a fetched object for the agent. Prints a stable header line so
 * the agent can cite the source ([plane] namespace/object_id), then a
 * compact metadata block of fields the canonical API consistently
 * returns, and finally the body content. Unknown extra fields are
 * appended in stable key order so plane-specific shapes (vault_path,
 * event_at, participants, blob refs, etc.) round-trip without this tool
 * having to know each plane's schema.
 */
function formatObject(
  plane: GetParams["plane"],
  namespace: string,
  objectId: string,
  row: Record<string, unknown>,
): string {
  const lines: string[] = [];
  lines.push(`[${plane}] ${namespace}/${objectId}`);
  lines.push("");

  const headerKeys = [
    "title",
    "state",
    "importance",
    "event_at",
    "ingested_at",
    "created_at",
    "updated_at",
    "modality",
    "source_context",
    "vault_path",
    "topics",
    "tags",
    "participants",
  ];
  const seen = new Set<string>(["namespace", "object_id", "content", "summary", "body"]);
  for (const key of headerKeys) {
    if (!(key in row)) continue;
    seen.add(key);
    const value = row[key];
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    lines.push(`${key}: ${renderValue(value)}`);
  }

  const extraKeys = Object.keys(row)
    .filter((k) => !seen.has(k))
    .sort();
  for (const key of extraKeys) {
    const value = row[key];
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    lines.push(`${key}: ${renderValue(value)}`);
  }

  const content = pickContent(row);
  if (content !== undefined) {
    lines.push("");
    lines.push(content);
  }

  return lines.join("\n").trimEnd();
}

function pickContent(row: Record<string, unknown>): string | undefined {
  if (typeof row.content === "string") return row.content;
  if (typeof row.body === "string") return row.body;
  if (typeof row.summary === "string") return row.summary;
  return undefined;
}

function renderValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map((v) => renderValue(v)).join(", ");
  return JSON.stringify(value);
}

function toolText(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function toolError(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function errorMessage(err: unknown): string {
  if (err instanceof MusubiError) return `${err.name}: ${err.message}`;
  if (err instanceof Error) return err.message;
  return String(err);
}
