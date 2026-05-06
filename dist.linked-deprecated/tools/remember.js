import { MusubiError } from "../musubi/errors.js";
import { resolvePresence } from "../presence/resolver.js";
import { RememberParameters } from "./parameters.js";
const DEFAULT_IMPORTANCE = 7;
const CAPTURE_SOURCE = "openclaw-agent-remember";
export function createRememberTool(options) {
    const { client, config, agentId } = options;
    return {
        recommendedOptional: true,
        definition: {
            name: "musubi_remember",
            description: "Explicitly capture something into Musubi's episodic memory. Use for things the agent judges as load-bearing — decisions, facts, commitments, observations. Passive capture already mirrors every turn; use this for higher-signal items.",
            parameters: RememberParameters,
            async execute(toolCallId, params) {
                let presence;
                try {
                    presence = resolvePresence(config, { agentId });
                }
                catch (err) {
                    return errorResult(`Presence unresolved: ${errorMessage(err)}`);
                }
                const idempotencyKey = params.idempotencyKey ?? `openclaw-remember:${toolCallId}`;
                try {
                    const response = await client.post("/v1/episodic", {
                        // Canonical `CaptureRequest` (Musubi v1.0) accepts
                        // {namespace, content, summary?, tags, importance, created_at?}.
                        // Audit metadata folds into `tags` with prefixes so it
                        // round-trips without requiring a canonical API extension;
                        // see `src/capture/translate.ts::toCanonicalCapture` for
                        // the matching shape used by the passive capture mirror.
                        body: {
                            namespace: presence.namespaces.episodic,
                            content: params.content,
                            importance: params.importance ?? DEFAULT_IMPORTANCE,
                            tags: [...(params.topics ?? []), `src:${CAPTURE_SOURCE}`, `ref:${toolCallId}`],
                        },
                        idempotencyKey,
                        token: presence.token,
                    });
                    const storedId = response?.object_id ?? "(no id)";
                    return successResult(`Remembered in Musubi episodic (${presence.namespaces.episodic}) — id ${storedId}.`);
                }
                catch (err) {
                    return errorResult(`Musubi remember failed: ${errorMessage(err)}`);
                }
            },
        },
    };
}
function successResult(text) {
    return { content: [{ type: "text", text }] };
}
function errorResult(text) {
    return { content: [{ type: "text", text }], isError: true };
}
function errorMessage(err) {
    if (err instanceof MusubiError)
        return `${err.name}: ${err.message}`;
    if (err instanceof Error)
        return err.message;
    return String(err);
}
//# sourceMappingURL=remember.js.map