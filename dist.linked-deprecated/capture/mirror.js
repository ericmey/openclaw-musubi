import { resolvePresence } from "../presence/resolver.js";
import { deriveIdempotencyKey, toCanonicalCapture, translateCaptureEvent, } from "./translate.js";
const noopLogger = {
    warn() {
        /* no-op */
    },
};
export function createCaptureMirror(options) {
    const { client, config } = options;
    const logger = options.logger ?? noopLogger;
    const now = options.now ?? (() => new Date());
    const enabled = config.capture?.mirrorOpenClawMemory !== false;
    return {
        enabled,
        async handleEvent(event) {
            if (!enabled)
                return;
            const resolved = resolveOrSkip(event, config, now, logger);
            if (resolved === undefined)
                return;
            const { presence, payload } = resolved;
            try {
                await client.post("/v1/episodic", {
                    body: toCanonicalCapture(payload),
                    idempotencyKey: deriveIdempotencyKey(event),
                    token: presence.token,
                });
            }
            catch (err) {
                logger.warn("musubi: mirror handleEvent failed; OpenClaw write unaffected", {
                    source_ref: event.id,
                    error: errorMessage(err),
                });
            }
        },
        async handleBatch(events) {
            if (!enabled || events.length === 0)
                return;
            // One namespace per batch — the canonical `/v1/episodic/batch`
            // endpoint takes a single top-level `namespace` and a list of
            // `items` rather than repeating the namespace per row. Group
            // events by their resolved (namespace, token) pair before dispatching
            // so per-agent token isolation is preserved even when two agents
            // share a namespace mapping.
            const byKey = new Map();
            for (const event of events) {
                const resolved = resolveOrSkip(event, config, now, logger);
                if (resolved === undefined)
                    continue;
                const { presence, payload } = resolved;
                const canonical = toCanonicalCapture(payload);
                const key = `${canonical.namespace}::${presence.token}`;
                const bucket = byKey.get(key) ?? {
                    namespace: canonical.namespace,
                    items: [],
                    keys: [],
                    token: presence.token,
                };
                bucket.items.push(canonical);
                bucket.keys.push(deriveIdempotencyKey(event));
                byKey.set(key, bucket);
            }
            if (byKey.size === 0)
                return;
            for (const [, bucket] of byKey) {
                const items = bucket.items.map((c) => ({
                    content: c.content,
                    importance: c.importance,
                    tags: c.tags,
                }));
                try {
                    await client.post("/v1/episodic/batch", {
                        body: { namespace: bucket.namespace, items },
                        idempotencyKey: `batch:${bucket.keys.join(",")}`,
                        token: bucket.token,
                    });
                }
                catch (err) {
                    logger.warn("musubi: mirror handleBatch failed; OpenClaw write unaffected", {
                        namespace: bucket.namespace,
                        batch_size: bucket.items.length,
                        error: errorMessage(err),
                    });
                }
            }
        },
    };
}
function resolveOrSkip(event, config, now, logger) {
    if (!event.content || event.content.length === 0)
        return undefined;
    let presence;
    try {
        presence = resolvePresence(config, { agentId: event.agentId });
    }
    catch (err) {
        logger.warn("musubi: mirror skipped event; presence resolution failed", {
            source_ref: event.id,
            error: errorMessage(err),
        });
        return undefined;
    }
    const payload = translateCaptureEvent(event, presence, now);
    return { presence, payload };
}
function errorMessage(err) {
    if (err instanceof Error)
        return err.message;
    return String(err);
}
//# sourceMappingURL=mirror.js.map